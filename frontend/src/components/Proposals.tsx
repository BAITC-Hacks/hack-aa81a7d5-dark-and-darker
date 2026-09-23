import { useState } from 'react';
import { send, useResource } from '../api';
import { useAction, useHub } from '../context';
import { date, proposalLabels, type Proposal } from '../types';
import { Empty, ErrorState, Loading, TeamSelect } from './ui';

type ProposalDraft = { message: string; solution: string };
// Retain drafts during navigation even if this browser disables sessionStorage.
const memoryDrafts = new Map<string, ProposalDraft>();
function readDraft(key: string): ProposalDraft {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (typeof value?.message === 'string' && typeof value?.solution === 'string') return value;
  } catch { /* Fall back to this tab's memory. */ }
  return memoryDrafts.get(key) ?? { message: '', solution: '' };
}
function storeDraft(key: string, draft: ProposalDraft) {
  memoryDrafts.set(key, draft);
  try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* Keep the in-memory draft. */ }
}
function clearSentDraft(key: string, sent: ProposalDraft) {
  const current = readDraft(key);
  // An old request must not clear text entered after reopening the form.
  if (current.message !== sent.message || current.solution !== sent.solution) return;
  memoryDrafts.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* The in-memory copy is already cleared. */ }
}

export function ProposalCard({ proposal }: { proposal: Proposal }) {
  const { role, navigate, notify, refresh } = useHub();
  const { busy, run } = useAction();
  function decide(status: 'accepted' | 'rejected') {
    void run(async () => {
      await send<Proposal>(`/proposals/${proposal.id}/status`, 'PATCH', { status });
      notify(status === 'accepted' ? 'Предложение принято' : 'Предложение отклонено'); refresh();
    });
  }
  return <article className="panel proposal-card">
    <div className="section-heading"><button className="text-link" onClick={() => navigate(`task/${proposal.task_id}`)}>{proposal.task_title}</button><span className={`badge ${proposal.status}`}>{proposalLabels[proposal.status]}</span></div>
    <button className="team-link" onClick={() => navigate(`team/${proposal.team_id}`)}>{proposal.team_name} ↗</button>
    <div className="tags">{proposal.team_skills.map((skill) => <span key={skill}>{skill}</span>)}</div>
    <h4>Сообщение бизнесу</h4><p className="preserve">{proposal.message}</p>
    <h4>Предлагаемое решение</h4><p className="preserve">{proposal.proposed_solution}</p>
    <div className="proposal-footer"><span className="muted small">{date(proposal.created_at)} · {proposal.team_contact}</span>
      {role === 'business' && proposal.status === 'pending' && <div className="actions"><button disabled={busy} onClick={() => decide('accepted')}>Принять</button><button className="danger secondary" disabled={busy} onClick={() => decide('rejected')}>Отклонить</button></div>}
    </div>
  </article>;
}

export function ProposalsPage() {
  const { role, teamId, revision } = useHub();
  const [filter, setFilter] = useState('');
  const resource = useResource<Proposal[]>(role === 'business' ? '/proposals' : `/teams/${teamId}/proposals`, revision);
  const items = resource.data?.filter((item) => !filter || item.status === filter) ?? [];
  return <>
    <div className="page-heading"><div><p className="eyebrow">СОТРУДНИЧЕСТВО</p><h1>{role === 'business' ? 'Предложения команд' : 'Мои предложения'}</h1><p className="muted">{role === 'business' ? 'Познакомьтесь с подходом команд и примите решение самостоятельно.' : 'Следите за решениями бизнеса по предложениям выбранной команды.'}</p></div></div>
    <div className="toolbar">{role === 'student' && <TeamSelect />}<label>Статус предложения<select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">Все статусы</option>{Object.entries(proposalLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
    {resource.loading ? <Loading /> : resource.error ? <ErrorState message={resource.error} retry={resource.retry} /> : items.length ? <div className="proposal-list">{items.map((item) => <ProposalCard key={item.id} proposal={item} />)}</div> : <Empty title="Предложений пока нет"><p className="muted">{filter ? 'Попробуйте выбрать другой статус.' : 'Отправленные предложения появятся здесь.'}</p></Empty>}
  </>;
}

export function ProposalForm({ taskId }: { taskId: number }) {
  const { teamId, notify, refresh } = useHub();
  const key = `sana-proposal:${taskId}:${teamId}`;
  const [draft, setDraft] = useState(() => readDraft(key));
  const { message, solution } = draft;
  function update(patch: Partial<ProposalDraft>) {
    const next = { ...draft, ...patch };
    // Write on input, before a team switch can unmount this form.
    storeDraft(key, next); setDraft(next);
  }
  const { busy, run } = useAction();
  return <form className="panel proposal-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
    if (!message.trim() || !solution.trim()) throw new Error('Заполните сообщение и предлагаемое решение.');
    await send(`/tasks/${taskId}/proposals`, 'POST', { team_id: teamId, message, proposed_solution: solution });
    clearSentDraft(key, draft);
    setDraft({ message: '', solution: '' }); notify('Предложение отправлено. Статус: «На рассмотрении».'); refresh();
  }); }}>
    <h2>Предложить решение</h2><p className="muted">Расскажите о своей команде и подходе к задаче. Исполнителей выбирает бизнес.</p>
    <fieldset disabled={busy}><TeamSelect />
      <label className="field">Сообщение бизнесу<textarea required maxLength={10000} rows={3} value={message} onChange={(event) => update({ message: event.target.value })} placeholder="Почему вашей команде интересна эта задача?" /></label>
      <label className="field">Предлагаемое решение<textarea required maxLength={10000} rows={5} value={solution} onChange={(event) => update({ solution: event.target.value })} placeholder="Опишите подход, этапы работы и ожидаемый результат" /></label>
      <button type="submit">{busy ? 'Отправляем…' : 'Отправить предложение'}</button>
    </fieldset>
  </form>;
}
