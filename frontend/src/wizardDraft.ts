import { useEffect, useRef, useState } from 'react';
import { ApiError, send, taskConflictMessage } from './api';
import { useHub } from './context';
import { emptyFields, type Answers, type Task, type WizardState } from './types';

// Stable comparison also works for JSON returned with a different key order.
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}
type Recovery = { clientId: string; revision: number | null; state: WizardState; pendingState?: WizardState };
function recoveryKey(id?: number) { return `sana-wizard:${id ?? 'new'}`; }
function readRecovery(id?: number): Recovery | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(recoveryKey(id)) || 'null');
    if (value?.clientId && value.state?.fields && value.state?.questionSet?.questions?.length === 7) return value;
  } catch { /* Recovery is optional; SQLite is authoritative. */ }
}
function removeRecovery(id?: number) {
  try { sessionStorage.removeItem(recoveryKey(id)); } catch { /* Storage may be disabled. */ }
}
const cancelled = () => new DOMException('Действие отменено', 'AbortError');

export function useWizardDraft(initial?: Task) {
  const { questions, registerGuard, replaceRoute, navigate, notify, refresh } = useHub();
  const [boot] = useState(() => {
    const fields = initial ? Object.fromEntries(Object.keys(emptyFields).map((key) => [key, initial[key as keyof typeof emptyFields]])) as typeof emptyFields : { ...emptyFields };
    const baseline: WizardState = initial?.wizard_state ? { cardReview: null, ...initial.wizard_state } : {
      step: initial ? 4 : 1, fields, originalIdea: { ...fields },
      answers: Object.fromEntries(questions.map(({ field }) => [field, fields[field]])) as Answers,
      questionSet: { questions: questions.map(({ field, question }) => ({ field, question })) },
      hasQuestions: !!initial, hasCard: !!initial,
      questionsIdea: initial ? JSON.stringify([fields.title, fields.initial_description]) : '',
      questionInfo: null, cardInfo: null, cardReview: null,
    };
    const recovery = readRecovery(initial?.id);
    const ownPendingWrite = initial && recovery?.revision != null && initial.revision === recovery.revision + 1
      && recovery.pendingState && fingerprint(initial.wizard_state) === fingerprint(recovery.pendingState);
    const stale = !!(initial && recovery && recovery.revision !== initial.revision && !ownPendingWrite && fingerprint(recovery.state) !== fingerprint(baseline));
    return { baseline, state: !stale && recovery ? recovery.state : baseline, stale, clientId: recovery?.clientId ?? crypto.randomUUID() };
  });
  const [state, setState] = useState(boot.state);
  const [saved, setSaved] = useState(initial);
  const [conflict, setConflict] = useState(boot.stale);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const current = useRef(state);
  const task = useRef(initial);
  const baseline = useRef(fingerprint(boot.baseline));
  const blocked = useRef(boot.stale);
  const mounted = useRef(true);
  const paused = useRef(false);
  const generation = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingState = useRef<WizardState | undefined>(undefined);
  const pendingGeneration = useRef(false);
  const latest = useRef({ save, discard, schedule });
  latest.current = { save, discard, schedule };
  const dirty = fingerprint(state) !== baseline.current;

  function backup() {
    try {
      sessionStorage.setItem(recoveryKey(task.current?.id), JSON.stringify({
        clientId: boot.clientId, revision: task.current?.revision ?? null,
        state: pendingGeneration.current && pendingState.current ? pendingState.current : current.current,
        pendingState: pendingState.current,
      } satisfies Recovery));
    } catch { /* beforeunload still protects input if browser storage is full. */ }
  }
  function update(patch: Partial<WizardState>) {
    current.current = { ...current.current, ...patch };
    epoch.current++;
    setState(current.current); backup(); schedule();
  }
  function markConflict() {
    blocked.current = true; setConflict(true); clearTimeout(timer.current);
    notify(taskConflictMessage, true);
  }
  function persist(next: WizardState, expectedRevision?: number, operationEpoch = epoch.current): Promise<Task> {
    clearTimeout(timer.current);
    const operation = queue.current.catch(() => {}).then(async () => {
      if (!mounted.current || blocked.current || operationEpoch !== epoch.current) throw cancelled();
      if (expectedRevision !== undefined && task.current?.revision !== expectedRevision) {
        markConflict(); throw new ApiError('Задача уже изменена. Откройте актуальную карточку.', 409);
      }
      if (task.current && fingerprint(next) === baseline.current) return task.current;
      setSaving(true);
      try {
        const previous = task.current;
        pendingState.current = next; pendingGeneration.current = expectedRevision !== undefined; backup();
        const result = previous
          ? await send<Task>(`/tasks/${previous.id}/wizard`, 'PUT', { expected_revision: expectedRevision ?? previous.revision, state: next })
          : await send<Task>('/wizard-drafts', 'POST', { client_id: boot.clientId, state: next });
        task.current = result;
        if (!mounted.current) return result;
        if (expectedRevision !== undefined && operationEpoch === epoch.current) {
          current.current = next; setState(next);
        }
        setSaved(result);
        if (!previous) {
          replaceRoute(`new/${result.id}`);
          removeRecovery();
        }
        baseline.current = fingerprint(result.wizard_state);
        backup();
        if (!previous && fingerprint(next) !== baseline.current) {
          // A retried create may have succeeded before a reload/lost response.
          // Only its original revision is safe to resume automatically.
          if (result.revision !== 1) { markConflict(); throw new ApiError('Черновик уже изменён. Откройте актуальную карточку.', 409); }
          const resumed = await send<Task>(`/tasks/${result.id}/wizard`, 'PUT', { expected_revision: result.revision, state: next });
          task.current = resumed;
          baseline.current = fingerprint(resumed.wizard_state);
          if (mounted.current) { setSaved(resumed); backup(); }
          return resumed;
        }
        setSaveError(''); refresh();
        return result;
      } catch (failure) {
        if (mounted.current) {
          if (failure instanceof ApiError && failure.status === 409) markConflict();
          else setSaveError(failure instanceof Error ? failure.message : 'Не удалось сохранить черновик');
        }
        throw failure;
      } finally {
        if (mounted.current) { pendingState.current = undefined; pendingGeneration.current = false; backup(); setSaving(false); }
      }
    });
    queue.current = operation;
    return operation;
  }
  function schedule() {
    clearTimeout(timer.current);
    if (paused.current || blocked.current || generation.current || fingerprint(current.current) === baseline.current) return;
    if (!task.current && (!current.current.fields.title.trim() || !current.current.fields.initial_description.trim())) return;
    timer.current = setTimeout(() => { void persist(current.current).catch(() => {}); }, 800);
  }
  async function save() {
    clearTimeout(timer.current);
    if (blocked.current) throw new Error('Сначала откройте актуальную карточку. Новые изменения на сервере защищены.');
    if (!current.current.fields.title.trim() || !current.current.fields.initial_description.trim()) throw new Error('Укажите название и краткое описание задачи.');
    return persist(current.current);
  }
  async function discard() {
    paused.current = true; clearTimeout(timer.current); generation.current?.abort(); epoch.current++;
    await queue.current.catch(() => {});
    baseline.current = fingerprint(current.current);
    removeRecovery(task.current?.id);
    // Also remove a pre-ID backup if a create response was lost.
    if (readRecovery()?.clientId === boot.clientId) removeRecovery();
  }
  async function openLatest() {
    const id = task.current?.id;
    if (!id) return;
    await discard(); navigate(`task/${id}`);
  }
  function startGeneration() {
    generation.current?.abort();
    const controller = new AbortController(); generation.current = controller;
    clearTimeout(timer.current);
    const version = task.current!.revision;
    const operationEpoch = epoch.current;
    return {
      signal: controller.signal,
      async apply(patch: Partial<WizardState>) {
        if (!mounted.current || controller.signal.aborted || operationEpoch !== epoch.current) throw cancelled();
        const next = { ...current.current, ...patch };
        await persist(next, version, operationEpoch);
        if (!mounted.current || controller.signal.aborted || operationEpoch !== epoch.current) throw cancelled();
        current.current = next; setState(next); backup();
      },
      finish() { if (generation.current === controller) generation.current = null; },
    };
  }

  useEffect(() => {
    mounted.current = true;
    latest.current.schedule();
    const unregister = registerGuard({
      dirty: () => fingerprint(current.current) !== baseline.current,
      pause: () => { paused.current = true; clearTimeout(timer.current); },
      resume: () => { paused.current = false; latest.current.schedule(); },
      save: async () => { generation.current?.abort(); await latest.current.save(); },
      discard: () => latest.current.discard(),
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (fingerprint(current.current) === baseline.current) return;
      backup();
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      mounted.current = false; clearTimeout(timer.current); generation.current?.abort();
      unregister(); window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [registerGuard]);

  return { state, update, saved, dirty, saving, saveError, conflict, save, startGeneration, openLatest, markConflict,
    async move(step: number) { await save(); update({ step }); await save(); },
    async confirmed(result: Task) { task.current = result; setSaved(result); backup(); },
  };
}
