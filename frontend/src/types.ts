export type Role = 'business' | 'student';
export type CriterionField = 'context' | 'materials' | 'expected_result' | 'success_criteria' | 'constraints' | 'target_users' | 'business_contact';
export type TaskFields = Record<CriterionField, string> & { title: string; initial_description: string };
export type Task = TaskFields & {
  id: number; business_id: number; organization: string; business_name: string;
  readiness_score: number; readiness_level: string; status: 'draft' | 'published';
  is_confirmed: boolean; created_at: string; updated_at: string;
};
export type Team = { id: number; name: string; description: string; skills: string[]; members_count: number; contact: string };
export type Proposal = {
  id: number; task_id: number; team_id: number; message: string; proposed_solution: string;
  status: 'pending' | 'accepted' | 'rejected'; created_at: string;
  task_title: string; task_status: Task['status']; team_name: string; team_skills: string[]; team_contact: string;
};
export type Question = { field: CriterionField; label: string; weight: number; question: string };
export type Readiness = { score: number; level: string; criteria: { field: CriterionField; label: string; maximum: number; points: number }[]; missing: string[]; recommendations: string[] };
export const emptyFields: TaskFields = {
  title: '', initial_description: '', context: '', materials: '', expected_result: '', success_criteria: '',
  constraints: '', target_users: '', business_contact: '',
};
export const proposalLabels = { pending: 'На рассмотрении', accepted: 'Принято', rejected: 'Отклонено' };
export const levels = ['Черновик', 'Рабочая', 'Готовая', 'Приоритетная'];
export function date(value: string) { return new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }); }
