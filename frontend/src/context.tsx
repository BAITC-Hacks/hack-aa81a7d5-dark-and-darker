import { createContext, useContext, useState } from 'react';
import type { Question, Role, Team } from './types';

export type HubContext = {
  role: Role; teamId: number; setTeamId: (id: number) => void; teams: Team[]; questions: Question[];
  navigate: (route: string) => void; notify: (text: string, error?: boolean) => void;
  revision: number; refresh: () => void;
};
export const Context = createContext<HubContext | null>(null);
export function useHub() {
  const value = useContext(Context);
  if (!value) throw new Error('Missing Hub context');
  return value;
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const { notify } = useHub();
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await action(); }
    catch (error) { notify(error instanceof Error ? error.message : 'Не удалось выполнить действие', true); }
    finally { setBusy(false); }
  }
  return { busy, run };
}
