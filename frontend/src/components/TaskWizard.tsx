import { useEffect, useState } from 'react';
import { send, useResource } from '../api';
import { useAction, useHub } from '../context';
import { emptyFields, type Task, type TaskFields } from '../types';
import { CardContent, ErrorState, Loading } from './ui';

export function TaskWizard({ taskId }: { taskId?: number }) {
  const task = useResource<Task>(taskId ? `/tasks/${taskId}` : null);
  if (taskId && task.loading) return <Loading />;
  if (task.error) return <ErrorState message={task.error} retry={task.retry} />;
  return <Wizard initial={task.data} />;
}

function Wizard({ initial }: { initial?: Task }) {
  const { questions, notify, navigate, refresh } = useHub();
  const { busy, run } = useAction();
  const [step, setStep] = useState(initial ? 4 : 1);
  const [saved, setSaved] = useState<Task | undefined>(initial);
  const [fields, setFields] = useState<TaskFields>(() => initial
    ? Object.fromEntries(Object.keys(emptyFields).map((key) => [key, initial[key as keyof TaskFields]])) as TaskFields
    : { ...emptyFields });
  const dirty = !saved || Object.keys(emptyFields).some((key) => fields[key as keyof TaskFields] !== saved[key as keyof TaskFields]);
  const confirmed = !!saved?.is_confirmed && !dirty;
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  function change(key: keyof TaskFields, value: string) { setFields((current) => ({ ...current, [key]: value })); }
  async function save() {
    if (!fields.title.trim() || !fields.initial_description.trim()) throw new Error('Укажите название и краткое описание задачи.');
    if (saved && !dirty) return saved;
    const task = await send<Task>(saved ? `/tasks/${saved.id}` : '/tasks', saved ? 'PATCH' : 'POST', fields);
    setSaved(task);
    setFields(Object.fromEntries(Object.keys(emptyFields).map((key) => [key, task[key as keyof TaskFields]])) as TaskFields);
    refresh();
    return task;
  }
  async function go(next: number) { await save(); setStep(next); }
  async function confirm() {
    const task = await save();
    const result = await send<Task>(`/tasks/${task.id}/confirm`, 'POST');
    setSaved(result); refresh(); notify('Карточка подтверждена. Рейтинг рассчитан.');
    navigate(`task/${result.id}`);
  }
  function field(key: keyof TaskFields, label: string, description?: string) {
    return <div className="field" key={key}><label htmlFor={`task-field-${key}`}><span>{label}{(key === 'title' || key === 'initial_description') && <span className="required"> *</span>}</span></label>
      {description && <small>{description}</small>}
      {key === 'title' ? <input id={`task-field-${key}`} name={key} value={fields[key]} maxLength={200} required onChange={(event) => change(key, event.target.value)} placeholder="Например, анализ отзывов клиентов" />
        : <textarea id={`task-field-${key}`} name={key} value={fields[key]} rows={key === 'initial_description' ? 3 : 4} maxLength={10000} required={key === 'initial_description'} onChange={(event) => change(key, event.target.value)} placeholder="Введите информацию, которой располагаете" />}
    </div>;
  }

  return <>
    <div className="page-heading"><div><p className="eyebrow">ОТ ИДЕИ К ПРОЕКТУ</p><h1>{initial ? 'Редактирование задачи' : 'Конструктор задачи'}</h1><p className="muted">Уточните детали, проверьте карточку и подтвердите её перед публикацией.</p></div></div>
    <ol className="steps">{['Идея', 'Уточнения', 'Карточка', 'Подтверждение'].map((label, index) => <li key={label} className={step === index + 1 ? 'active' : step > index + 1 ? 'done' : ''} aria-current={step === index + 1 ? 'step' : undefined}><span>{step > index + 1 ? '✓' : index + 1}</span>{label}</li>)}</ol>
    <form className="panel wizard" onSubmit={(event) => { event.preventDefault(); void run(() => step < 4 ? go(step + 1) : confirm()); }}>
      <fieldset disabled={busy}>
        <div className="section-heading"><h2>{['Расскажите о своей идее', 'Помогите команде понять задачу', 'Проверьте структуру карточки', 'Последние правки и подтверждение'][step - 1]}</h2><span className="muted small">Шаг {step} из 4</span></div>
        {step === 1 && <>{field('title', 'Название задачи')}{field('initial_description', 'Краткое описание', 'Опишите суть задачи своими словами. Детали уточним на следующем шаге.')}</>}
        {step === 2 && <><div className="info">Вопросы сформированы по локальному шаблону. Если сведений пока нет, оставьте поле пустым — их можно добавить позднее.</div>{questions.map((question, index) => field(question.field, `${index + 1}. ${question.question}`, `${question.label} · ${question.weight} баллов`))}</>}
        {step === 3 && <><div className="info">Карточка собрана из ваших ответов. Система не добавляет фактов. На следующем шаге можно отредактировать любое поле.</div><CardContent fields={fields} /></>}
        {step === 4 && <>
          <div className="info">{confirmed ? 'Текущая версия подтверждена.' : 'Проверьте все поля и подтвердите карточку вручную. Любое сохранённое изменение сбрасывает подтверждение.'} {saved?.status === 'published' && 'Сохранение изменений вернёт опубликованную задачу в черновик до повторной публикации.'}</div>
          {field('title', 'Название задачи')}{field('initial_description', 'Краткое описание')}
          {questions.map((question) => field(question.field, question.label))}
        </>}
        <div className="form-footer">
          <div className="actions">{step > 1 && <button type="button" className="secondary" onClick={() => void run(() => go(step - 1))}>Назад</button>}
            <button type="button" className="quiet" onClick={() => void run(async () => { const result = await save(); notify('Черновик сохранён'); navigate(`task/${result.id}`); })}>Сохранить и выйти</button></div>
          <button type="submit">{busy ? 'Сохраняем…' : step === 4 ? 'Подтвердить карточку' : step === 2 ? 'Сформировать карточку →' : 'Далее →'}</button>
        </div>
        <p className="muted small">{saved ? `Задача №${saved.id}. ${dirty ? 'Есть несохранённые изменения.' : 'Изменения сохранены.'}` : 'Черновик будет сохранён после первого шага.'} Ответы сохраняются при переходах между шагами.</p>
      </fieldset>
    </form>
  </>;
}
