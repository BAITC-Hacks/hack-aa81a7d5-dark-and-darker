import { useResource } from '../api';
import { useHub } from '../context';
import type { Team } from '../types';
import { ErrorState, Loading } from './ui';

function TeamCard({ team, detailed = false }: { team: Team; detailed?: boolean }) {
  const { role, teamId, setTeamId, navigate, notify } = useHub();
  return <article className={`panel team-card ${detailed ? 'team-detailed' : ''}`}>
    <div className="team-top"><div className={`team-avatar avatar-${team.id % 5}`}>{team.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</div><span className="muted small">{team.members_count} участника</span></div>
    <h2>{team.name}</h2><p className="muted">{team.description}</p><div className="tags">{team.skills.map((skill) => <span key={skill}>{skill}</span>)}</div>
    <div className="team-contact"><span className="muted small">Контакт команды</span><p>{team.contact}</p></div>
    <div className="actions">{!detailed && <button className="secondary" onClick={() => navigate(`team/${team.id}`)}>Профиль команды →</button>}
      {role === 'student' && <button className={teamId === team.id ? 'quiet' : ''} disabled={teamId === team.id} onClick={() => { setTeamId(team.id); notify(`Выбрана команда ${team.name}`); }}>{teamId === team.id ? '✓ Ваша команда' : 'Выбрать команду'}</button>}
    </div>
  </article>;
}

export function TeamsPage() {
  const { teams } = useHub();
  return <><div className="page-heading"><div><p className="eyebrow">СИЛА СОТРУДНИЧЕСТВА</p><h1>Студенческие команды</h1><p className="muted">Разные навыки и общий интерес к задачам, которые имеют значение.</p></div></div><p className="result-count">Демонстрационные профили · {teams.length} команд</p><div className="team-grid">{teams.map((team) => <TeamCard key={team.id} team={team} />)}</div></>;
}

export function TeamPage({ teamId }: { teamId: number }) {
  const { navigate } = useHub();
  const team = useResource<Team>(`/teams/${teamId}`);
  if (team.loading) return <Loading />;
  if (team.error) return <ErrorState message={team.error} retry={team.retry} />;
  return <><button className="back-link" onClick={() => navigate('teams')}>← Все команды</button><div className="page-heading"><div><p className="eyebrow">ЗНАКОМСТВО С КОМАНДОЙ</p><h1>Профиль команды</h1></div></div>{team.data && <TeamCard team={team.data} detailed />}</>;
}
