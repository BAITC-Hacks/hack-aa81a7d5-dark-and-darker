import { useState } from 'react';
import { ApiError, send, taskConflictMessage, useResource } from '../api';
import { useAction, useHub } from '../context';
import { date, levels, type Proposal, type Readiness, type Task } from '../types';
import { CardContent, Empty, ErrorState, Loading, ReadinessPanel, Score, TeamSelect } from './ui';
import { ProposalCard, ProposalForm } from './Proposals';
import { useCatalogFilters } from '../catalogFilters';

export function TasksPage() {
  const { role, navigate, revision } = useHub();
  const { filters: { search, level, sort, status }, update, reset } = useCatalogFilters(role);
  const params = new URLSearchParams({ sort, search });
  if (level) params.set('readiness_level', level);
  if (role === 'student') params.set('status', 'published');
  else { params.set('business_id', '1'); if (status) params.set('status', status); }
  const resource = useResource<Task[]>(`/tasks?${params}`, revision);
  return <>
    <div className="page-heading"><div><p className="eyebrow">БИЗНЕС × СТУДЕНЧЕСКИЕ КОМАНДЫ</p><h1>{role === 'business' ? 'Мои задачи' : 'Каталог задач'}</h1><p className="muted">{role === 'business' ? 'Превратите бизнес-потребность в понятную задачу для талантливых команд.' : 'Реальные бизнес-задачи. Ваши идеи. Первый шаг к совместному проекту.'}</p></div>{role === 'business' && <button onClick={() => navigate('new')}>＋ Создать задачу</button>}</div>
    <div className="catalog-note"><span className="note-icon">✦</span><div><strong>{role === 'business' ? 'Хороший проект начинается с понятной задачи' : 'Выбирайте задачу, в которой можете быть полезны'}</strong><p>Рейтинг показывает полноту описания. Задачи с любым рейтингом открыты для сотрудничества.</p></div></div>
    <div className="toolbar catalog-toolbar">
      <label className="search">Поиск<input type="search" aria-label="Поиск задач" maxLength={200} placeholder="Название или описание задачи" value={search} onChange={(event) => update({ search: event.target.value })} /></label>
      <label>Уровень готовности<select value={level} onChange={(event) => update({ level: event.target.value })}><option value="">Все уровни</option>{levels.map((item) => <option key={item}>{item}</option>)}</select></label>
      {role === 'business' && <label>Статус задачи<select value={status} onChange={(event) => update({ status: event.target.value })}><option value="">Все задачи</option><option value="draft">Черновики</option><option value="published">Опубликованы</option></select></label>}
      <label>Сортировка<select value={sort} onChange={(event) => update({ sort: event.target.value })}><option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option><option value="score_desc">Рейтинг: по убыванию</option><option value="score_asc">Рейтинг: по возрастанию</option></select></label>
    </div>
    {resource.loading ? <Loading /> : resource.error ? <ErrorState message={resource.error} retry={resource.retry} /> : <>
      <p className="result-count">Найдено задач: {resource.data?.length ?? 0}</p>
      {resource.data?.length ? <div className="task-grid">{resource.data.map((task) => <article className="panel task-card" key={task.id}>
        <div className="task-meta"><span className="organization"><span className="org-icon">S</span>{task.organization}</span><span className={`badge ${task.status}`}>{task.status === 'published' ? 'Опубликована' : 'Черновик'}</span></div>
        <h2><button className="heading-link" onClick={() => navigate(`task/${task.id}`)}>{task.title}</button></h2><p className="task-description">{task.initial_description}</p>
        <div className="task-bottom"><Score score={task.readiness_score} level={task.readiness_level} /><div className="card-footer"><span className="muted small">{date(task.created_at)}</span><button className="text-link" onClick={() => navigate(`task/${task.id}`)}>Подробнее →</button></div></div>
      </article>)}</div> : <Empty title="Задачи не найдены"><p className="muted">Измените фильтры или поисковый запрос.</p><button className="secondary" onClick={reset}>Сбросить фильтры</button></Empty>}
    </>}
  </>;
}

export function TaskPage({ taskId }: { taskId: number }) {
  const { role, teamId, revision, navigate, notify, refresh } = useHub();
  const task = useResource<Task>(`/tasks/${taskId}`, revision);
  const rating = useResource<Readiness>(`/tasks/${taskId}/readiness`, revision);
  const proposals = useResource<Proposal[]>(role === 'business' ? `/tasks/${taskId}/proposals` : `/teams/${teamId}/proposals`, revision);
  const { busy, run } = useAction();
  const [conflict, setConflict] = useState(false);
  async function changeStatus(action: 'confirm' | 'publish') {
    if (!task.data || conflict) return;
    try {
      await send(`/tasks/${taskId}/${action}`, 'POST', { expected_revision: task.data.revision });
      notify(action === 'confirm' ? 'Карточка подтверждена' : 'Задача опубликована и доступна студентам');
      refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      else throw error;
    }
  }
  const items = proposals.data?.filter((item) => item.task_id === taskId) ?? [];
  if (task.loading || rating.loading) return <Loading />;
  if (task.error) return <ErrorState message={task.error} retry={task.retry} />;
  if (rating.error) return <ErrorState message={rating.error} retry={rating.retry} />;
  if (!task.data || !rating.data) return null;
  const data = task.data;
  if (role === 'student' && data.status !== 'published') return <Empty title="Задача пока не опубликована"><p className="muted">Бизнес редактирует карточку. Существующие предложения доступны в разделе «Мои предложения».</p><button onClick={() => navigate('tasks')}>Открыть каталог</button></Empty>;
  return <>
    <button className="back-link" onClick={() => navigate('tasks')}>← {role === 'business' ? 'Мои задачи' : 'Каталог задач'}</button>
    <div className="page-heading"><div><p className="eyebrow">{data.organization} · ЗАДАЧА №{data.id}</p><h1>{data.title}</h1><div className="actions"><span className={`badge ${data.status}`}>{data.status === 'published' ? 'Опубликована' : 'Черновик'}</span><span className="muted small">Создана {date(data.created_at)}</span></div></div></div>
    {conflict && <div className="info fallback-info" role="alert"><p>{taskConflictMessage}</p><button onClick={() => { setConflict(false); task.retry(); rating.retry(); }}>Открыть актуальную версию</button></div>}
    <div className="detail-grid"><div>
      {role === 'business' && <section className="panel publish-panel"><div><h3>{data.is_confirmed ? 'Карточка подтверждена' : 'Ожидает вашего подтверждения'}</h3><p className="muted small">{data.is_confirmed ? 'Можно публиковать задачу независимо от рейтинга.' : 'Проверьте сведения. Для публикации подтвердите текущую версию.'}</p></div><div className="actions">
        <button className="secondary" disabled={busy} onClick={() => navigate(`edit/${taskId}`)}>Редактировать</button>
        {!data.is_confirmed && <button disabled={busy || conflict} onClick={() => void run(() => changeStatus('confirm'))}>Подтвердить карточку</button>}
        {data.status !== 'published' && <button disabled={busy || conflict || !data.is_confirmed} onClick={() => void run(() => changeStatus('publish'))}>Опубликовать</button>}
      </div></section>}
      <section className="panel"><CardContent fields={data} /></section>
      <section className="task-proposals"><h2>{role === 'business' ? 'Предложения по задаче' : 'Ваше предложение'}</h2>
        {role === 'student' && items.length > 0 && <TeamSelect />}
        {proposals.loading ? <Loading /> : proposals.error ? <ErrorState message={proposals.error} retry={proposals.retry} /> : items.length ? <div className="proposal-list">{items.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} />)}</div> : role === 'business' ? <Empty title="Команды ещё не откликнулись"><p className="muted">Предложения появятся здесь после публикации задачи.</p></Empty> : <ProposalForm key={`${taskId}-${teamId}`} taskId={taskId} />}
      </section>
    </div><aside><ReadinessPanel readiness={rating.data} /><div className="panel contact-panel"><h3>Представитель бизнеса</h3><strong>{data.business_name}</strong><p className="muted">{data.organization}</p><p className="preserve">{data.business_contact || 'Способ связи пока не указан'}</p></div></aside></div>
  </>;
}
