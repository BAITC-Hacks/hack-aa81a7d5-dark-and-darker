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
type PendingWrite = { expected_revision: number; operation_id: string; state: WizardState };
const SAVE_TIMEOUT_MS = 30_000;
const LEAVE_TIMEOUT_MS = 1_000;
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
  const discarded = useRef(false);
  const paused = useRef(false);
  const generation = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const savingRequest = useRef<AbortController | null>(null);
  const pendingWrite = useRef<PendingWrite | undefined>(undefined);
  const pendingState = useRef<WizardState | undefined>(undefined);
  const pendingGeneration = useRef(false);
  const pendingGenerationEpoch = useRef<number | undefined>(undefined);
  const latest = useRef({ save, discard, schedule });
  latest.current = { save, discard, schedule };
  const isDirty = () => !discarded.current && (!!pendingState.current || fingerprint(current.current) !== baseline.current);
  const dirty = isDirty();

  function backup() {
    if (!mounted.current || discarded.current) return;
    try {
      sessionStorage.setItem(recoveryKey(task.current?.id), JSON.stringify({
        clientId: boot.clientId, revision: task.current?.revision ?? null,
        state: pendingGeneration.current && pendingGenerationEpoch.current === epoch.current && pendingState.current
          ? pendingState.current : current.current,
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
      if (!mounted.current || discarded.current || blocked.current || operationEpoch !== epoch.current) throw cancelled();
      const recoverGeneration = expectedRevision === undefined && pendingGeneration.current
        && pendingGenerationEpoch.current === operationEpoch && pendingState.current;
      if (recoverGeneration) next = recoverGeneration;
      if (expectedRevision !== undefined && task.current?.revision !== expectedRevision) {
        markConflict(); throw new ApiError('Задача уже изменена. Откройте актуальную карточку.', 409);
      }
      if (task.current && !pendingWrite.current && fingerprint(next) === baseline.current) return task.current;
      const controller = new AbortController();
      savingRequest.current = controller;
      let timedOut = false;
      let succeeded = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, SAVE_TIMEOUT_MS);
      setSaving(true);
      const acknowledge = (result: Task) => {
        if (!mounted.current || discarded.current) throw cancelled();
        task.current = result;
        baseline.current = fingerprint(result.wizard_state);
        setSaved(result); backup();
      };
      const write = async (body: PendingWrite) => {
        pendingWrite.current = body;
        pendingState.current = body.state; backup();
        const result = await send<Task>(`/tasks/${task.current!.id}/wizard`, 'PUT', body, controller.signal);
        acknowledge(result);
        pendingWrite.current = undefined;
        return result;
      };
      try {
        pendingGeneration.current = expectedRevision !== undefined || !!recoverGeneration;
        if (expectedRevision !== undefined) pendingGenerationEpoch.current = operationEpoch;
        if (!task.current) {
          pendingState.current = next; backup();
          const created = await send<Task>('/wizard-drafts', 'POST', { client_id: boot.clientId, state: next }, controller.signal);
          acknowledge(created);
          replaceRoute(`new/${created.id}`); removeRecovery();
          // Creation is already idempotent. Never resume over another writer.
          if (fingerprint(next) !== baseline.current && created.revision !== 1) {
            markConflict(); throw new ApiError('Черновик уже изменён. Откройте актуальную карточку.', 409);
          }
        }
        // A lost response leaves an uncertain write. Resolve that exact operation
        // before attempting any newer local edits, using the same operation ID.
        if (pendingWrite.current) await write(pendingWrite.current);
        if (fingerprint(next) !== baseline.current) {
          await write({ expected_revision: task.current!.revision, operation_id: crypto.randomUUID(), state: next });
        }
        if ((expectedRevision !== undefined || recoverGeneration) && operationEpoch === epoch.current) {
          current.current = next; setState(next);
        }
        succeeded = true;
        setSaveError(''); refresh();
        return task.current!;
      } catch (failure) {
        const error = timedOut ? new Error('Сервер не ответил за 30 секунд. Ввод сохранён в этой вкладке. Повторите сохранение.') : failure;
        if (mounted.current && !discarded.current) {
          clearTimeout(timer.current); // No automatic retry loop after a failure.
          if (error instanceof ApiError && error.status === 409) markConflict();
          else setSaveError(error instanceof Error ? error.message : 'Не удалось сохранить черновик');
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        if (savingRequest.current === controller) savingRequest.current = null;
        if (mounted.current && !discarded.current) {
          // Retain an uncertain request in recovery storage until acknowledged.
          if (succeeded) { pendingState.current = undefined; pendingGeneration.current = false; }
          backup(); setSaving(false);
          // The baseline may have changed while the user reverted to its OLD
          // value. Always reconsider the latest input after a successful write.
          if (succeeded) schedule();
        }
      }
    });
    queue.current = operation;
    return operation;
  }
  function schedule() {
    clearTimeout(timer.current);
    if (!mounted.current || discarded.current || paused.current || blocked.current || generation.current || fingerprint(current.current) === baseline.current) return;
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
    discarded.current = true;
    paused.current = true; clearTimeout(timer.current); generation.current?.abort(); epoch.current++;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([queue.current.catch(() => {}), new Promise<void>((resolve) => {
        timeout = setTimeout(() => { savingRequest.current?.abort(); resolve(); }, LEAVE_TIMEOUT_MS);
      })]);
    } finally { clearTimeout(timeout); }
    // Aborting the client is not a server rollback. Leave persisted data intact.
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
      finish() { if (generation.current === controller) { generation.current = null; schedule(); } },
    };
  }

  useEffect(() => {
    mounted.current = true;
    latest.current.schedule();
    const unregister = registerGuard({
      dirty: isDirty,
      pause: () => { paused.current = true; clearTimeout(timer.current); },
      resume: () => { paused.current = false; latest.current.schedule(); },
      save: async () => { generation.current?.abort(); await latest.current.save(); },
      discard: () => latest.current.discard(),
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty()) return;
      backup();
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      mounted.current = false; clearTimeout(timer.current); generation.current?.abort(); savingRequest.current?.abort();
      unregister(); window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [registerGuard]);

  return { state, update, saved, dirty, saving, saveError, conflict, save, startGeneration, openLatest, markConflict,
    async move(step: number) { await save(); update({ step }); await save(); },
    async confirmed(result: Task) { task.current = result; setSaved(result); backup(); },
  };
}
