import { useCallback, useEffect, useRef, useState } from 'react';
import type { LeaveGuard } from './context';

export function useNavigation() {
  const [route, setRoute] = useState(() => location.hash.slice(1) || 'tasks');
  const current = useRef(route);
  const index = useRef<number>(history.state?.sanaIndex ?? 0);
  const guard = useRef<LeaveGuard | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const restoring = useRef(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);

  const acceptRoute = useCallback((next: string) => {
    current.current = next; setRoute(next); window.scrollTo(0, 0);
  }, []);
  const requestLeave = useCallback((action: () => void) => {
    if (pending.current) return;
    if (!guard.current?.dirty()) { action(); return; }
    guard.current.pause();
    pending.current = action; setError(''); setAsking(true);
  }, []);
  const navigate = useCallback((next: string) => {
    if (next === current.current) return;
    requestLeave(() => {
      history.pushState({ sanaIndex: ++index.current }, '', `#${next}`);
      acceptRoute(next);
    });
  }, [acceptRoute, requestLeave]);
  const replaceRoute = useCallback((next: string) => {
    history.replaceState({ sanaIndex: index.current }, '', `#${next}`);
    acceptRoute(next);
  }, [acceptRoute]);
  const registerGuard = useCallback((value: LeaveGuard) => {
    guard.current = value;
    return () => { if (guard.current === value) guard.current = null; };
  }, []);

  useEffect(() => {
    history.replaceState({ sanaIndex: index.current }, '', location.href);
    const onPop = () => {
      if (restoring.current) { restoring.current = false; return; }
      const next = location.hash.slice(1) || 'tasks';
      const nextIndex = history.state?.sanaIndex;
      if (guard.current?.dirty() && typeof nextIndex === 'number' && nextIndex !== index.current) {
        const delta = nextIndex - index.current;
        restoring.current = true;
        history.go(-delta);
        requestLeave(() => { history.go(delta); });
      } else if (guard.current?.dirty()) {
        history.replaceState({ sanaIndex: index.current }, '', `#${current.current}`);
        requestLeave(() => {
          history.pushState({ sanaIndex: ++index.current }, '', `#${next}`); acceptRoute(next);
        });
      } else {
        index.current = typeof nextIndex === 'number' ? nextIndex : index.current + 1;
        history.replaceState({ sanaIndex: index.current }, '', location.href);
        acceptRoute(next);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [acceptRoute, requestLeave]);
  useEffect(() => { if (asking) dialog.current?.showModal(); }, [asking]);

  function stay() {
    if (busy) return;
    pending.current = null; setAsking(false); guard.current?.resume();
  }
  async function leave(save: boolean) {
    setBusy(true); setError('');
    try {
      if (save) await guard.current?.save(); else await guard.current?.discard();
      const action = pending.current;
      pending.current = null; setAsking(false); action?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить черновик.'); }
    finally { setBusy(false); }
  }
  const leaveDialog = asking && <dialog ref={dialog} className="leave-dialog" aria-labelledby="leave-title" onCancel={(event) => { event.preventDefault(); stay(); }}>
    <h2 id="leave-title">Сохранить изменения перед выходом?</h2>
    <p>В конструкторе есть несохранённый ввод.</p>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Завершаем переход…</p>}
    <div className="actions">
      <button disabled={busy} onClick={() => void leave(true)}>Сохранить и выйти</button>
      <button disabled={busy} className="secondary" autoFocus onClick={stay}>Продолжить редактирование</button>
      <button disabled={busy} className="quiet" onClick={() => void leave(false)}>Выйти без сохранения</button>
    </div>
  </dialog>;
  return { route, entry: index.current, navigate, replaceRoute, registerGuard, requestLeave, leaveDialog };
}
