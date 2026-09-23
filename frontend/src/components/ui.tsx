import type { ReactNode } from 'react';
import { useHub } from '../context';
import type { Readiness, TaskFields } from '../types';

export function Loading() { return <div className="empty" role="status"><span className="spinner" />Загружаем данные…</div>; }
export function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return <div className="empty error" role="alert"><h3>Не удалось загрузить данные</h3><p>{message}</p><button onClick={retry}>Повторить</button></div>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-symbol">◇</div><h3>{title}</h3>{children}</div>;
}
export function Score({ score, level }: { score: number; level: string }) {
  return <div className={`score score-${score >= 90 ? 'high' : score >= 70 ? 'ready' : score >= 40 ? 'mid' : 'low'}`}>
    <div className="score-label"><span>{level}</span><strong>{score}<small> / 100</small></strong></div>
    <div className="meter" role="progressbar" aria-label="Рейтинг готовности" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score}><span style={{ width: `${score}%` }} /></div>
  </div>;
}
export function ReadinessPanel({ readiness }: { readiness: Readiness }) {
  return <section className="panel readiness"><p className="eyebrow">ГОТОВНОСТЬ ЗАДАЧИ</p><Score score={readiness.score} level={readiness.level} />
    <p className="muted small">Рейтинг помогает уточнить задачу. Публикация доступна даже с 0 баллов после подтверждения.</p>
    <div className="criteria">{readiness.criteria.map((item) => <div key={item.field}><span>{item.points ? '✓' : '○'} {item.label}</span><strong>{item.points}/{item.maximum}</strong></div>)}</div>
    <h3>{readiness.missing.length ? 'Что можно уточнить' : 'Все разделы заполнены'}</h3>
    {readiness.recommendations.length > 0 ? <ul className="recommendations">{readiness.recommendations.map((text) => <li key={text}>{text}</li>)}</ul> : <p className="muted small">Проверьте точность сведений перед публикацией.</p>}
    <p className="muted small">Баллы начисляются за непустые поля. Содержание оценивает человек.</p>
  </section>;
}
export function CardContent({ fields }: { fields: TaskFields }) {
  const { questions } = useHub();
  return <div className="card-content"><h2>{fields.title || 'Без названия'}</h2><p className="lead-text preserve">{fields.initial_description || 'Описание не указано'}</p>
    {questions.map((item) => <section key={item.field}><h3>{item.label}</h3><p className={`preserve ${fields[item.field] ? '' : 'muted'}`}>{fields[item.field] || 'Не указано'}</p></section>)}
  </div>;
}
export function TeamSelect() {
  const { teams, teamId, setTeamId } = useHub();
  return <label className="team-select">Демонстрационная команда<select value={teamId} onChange={(event) => setTeamId(Number(event.target.value))}>{teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label>;
}
