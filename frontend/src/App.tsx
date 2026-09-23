import { useEffect, useState } from 'react';
import { useResource } from './api';
import { Context } from './context';
import { TasksPage, TaskPage } from './components/Tasks';
import { TaskWizard } from './components/TaskWizard';
import { ProposalsPage } from './components/Proposals';
import { TeamsPage, TeamPage } from './components/Teams';
import { ErrorState, Loading } from './components/ui';
import type { Question, Role, Team } from './types';
import { useNavigation } from './navigation';

function readPreference(key: string, fallback: string) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function storePreference(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Demo remains usable without storage. */ }
}

export default function App() {
  const [role, setRole] = useState<Role>(() => readPreference('sana-role', 'business') === 'student' ? 'student' : 'business');
  const [teamId, setTeam] = useState(() => Number(readPreference('sana-team', '1')) || 1);
  const { route, entry, navigate, replaceRoute, registerGuard, requestLeave, leaveDialog } = useNavigation();
  const [revision, setRevision] = useState(0);
  const [toast, setToast] = useState<{ text: string; error: boolean; id: number }>();
  const teams = useResource<Team[]>('/teams');
  const questions = useResource<Question[]>('/questions');
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(undefined), toast.error ? 10000 : 6000);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    if (teams.data?.length && !teams.data.some((team) => team.id === teamId)) setTeam(teams.data[0].id);
  }, [teams.data, teamId]);
  function changeRole(next: Role) {
    if (next === role) return;
    requestLeave(() => { setRole(next); storePreference('sana-role', next); navigate('tasks'); });
  }
  function setTeamId(id: number) { setTeam(id); storePreference('sana-team', String(id)); }
  const nav = role === 'business'
    ? [{ route: 'tasks', icon: '▦', label: 'Мои задачи' }, { route: 'new', icon: '＋', label: 'Создать задачу' }, { route: 'proposals', icon: '↗', label: 'Предложения' }]
    : [{ route: 'tasks', icon: '▦', label: 'Каталог' }, { route: 'teams', icon: '◉', label: 'Команды' }, { route: 'proposals', icon: '↗', label: 'Мои предложения' }];
  const [page, id] = route.split('/');
  const numericId = Number(id);
  let content;
  if (teams.loading || questions.loading) content = <Loading />;
  else if (teams.error || questions.error) content = <ErrorState message={teams.error || questions.error || ''} retry={() => { teams.retry(); questions.retry(); }} />;
  else if (page === 'new' && role === 'business') content = <TaskWizard key={`new-${entry}`} taskId={numericId > 0 ? numericId : undefined} />;
  else if (page === 'edit' && numericId > 0 && role === 'business') content = <TaskWizard key={numericId} taskId={numericId} />;
  else if (page === 'task' && numericId > 0) content = <TaskPage key={`${numericId}-${role}`} taskId={numericId} />;
  else if (page === 'team' && numericId > 0) content = <TeamPage teamId={numericId} />;
  else if (page === 'teams') content = <TeamsPage />;
  else if (page === 'proposals') content = <ProposalsPage key={role} />;
  else content = <TasksPage key={role} />;

  return <Context.Provider value={{ role, teamId, setTeamId, teams: teams.data ?? [], questions: questions.data ?? [], navigate, replaceRoute, registerGuard,
    notify: (text, error = false) => setToast({ text, error, id: Date.now() }), revision, refresh: () => setRevision((value) => value + 1) }}>
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>К содержимому</a>
    <header className="topbar"><div className="brand"><span className="brand-mark">s<span>✦</span></span><div><strong>AI Sana</strong><span>Challenge Hub</span></div></div>
      <div className="header-right"><span className="demo-label">ДЕМО · HACKALEM AI</span><div className="role-switch" role="group" aria-label="Роль пользователя"><button aria-pressed={role === 'business'} className={role === 'business' ? 'selected' : ''} onClick={() => changeRole('business')}>Бизнес</button><button aria-pressed={role === 'student'} className={role === 'student' ? 'selected' : ''} onClick={() => changeRole('student')}>Студент</button></div><span className="user-avatar">{role === 'business' ? 'АС' : 'СТ'}</span></div>
    </header>
    <div className="app-layout"><aside className="sidebar"><p className="sidebar-caption">{role === 'business' ? 'КАБИНЕТ БИЗНЕСА' : 'ПРОСТРАНСТВО КОМАНДЫ'}</p><nav aria-label="Основная навигация">{nav.map((item) => <a key={item.route} href={`#${item.route}`} onClick={(event) => { event.preventDefault(); navigate(item.route); }} className={page === item.route || (item.route === 'tasks' && ['task', 'edit'].includes(page)) ? 'active' : ''}><span aria-hidden="true">{item.icon}</span>{item.label}</a>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-tip"><span>✦</span><strong>От задачи — к результату</strong><p>Бизнес делится вызовами.<br />Команды предлагают решения.</p></div><div className="identity"><span className="identity-dot" /><div><strong>{role === 'business' ? 'Sana Business Lab' : teams.data?.find((team) => team.id === teamId)?.name || 'Студенческая команда'}</strong><small>Демонстрационный профиль</small></div></div></div>
    </aside><main id="main-content" tabIndex={-1}><div className="content">{content}</div><footer>AI Sana Challenge Hub <span>Учебный MVP · Все исходные данные демонстрационные</span></footer></main></div>
    {leaveDialog}
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}><span>{toast.error ? '!' : '✓'}</span><p>{toast.text}</p><button aria-label="Закрыть уведомление" onClick={() => setToast(undefined)}>×</button></div>}
  </Context.Provider>;
}
