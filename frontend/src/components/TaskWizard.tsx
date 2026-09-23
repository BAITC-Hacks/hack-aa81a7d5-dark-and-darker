import { useEffect, useState } from 'react';
import { send, useResource } from '../api';
import { requestCard, requestQuestions } from '../ai';
import { useAction, useHub } from '../context';
import { emptyFields, type Answers, type GenerationInfo, type Task, type TaskFields } from '../types';
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
  const [answers, setAnswers] = useState<Answers>(() => Object.fromEntries(questions.map(({ field }) => [field, initial?.[field] ?? ''])) as Answers);
  const [activeQuestions, setActiveQuestions] = useState(questions);
  const [hasQuestions, setHasQuestions] = useState(!!initial);
  const [hasCard, setHasCard] = useState(!!initial);
  const [questionInfo, setQuestionInfo] = useState<GenerationInfo>();
  const [cardInfo, setCardInfo] = useState<GenerationInfo>();
  const [generating, setGenerating] = useState<'questions' | 'card' | null>(null);
  const [questionsIdea, setQuestionsIdea] = useState(initial ? JSON.stringify([initial.title, initial.initial_description]) : '');
  const dirty = !saved || Object.keys(emptyFields).some((key) => fields[key as keyof TaskFields] !== saved[key as keyof TaskFields]);
  const confirmed = !!saved?.is_confirmed && !dirty;
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  function change(key: keyof TaskFields, value: string) { setFields((current) => ({ ...current, [key]: value })); }
  async function save(nextFields: TaskFields = fields) {
    if (!nextFields.title.trim() || !nextFields.initial_description.trim()) throw new Error('Укажите название и краткое описание задачи.');
    if (saved && Object.keys(emptyFields).every((key) => nextFields[key as keyof TaskFields] === saved[key as keyof TaskFields])) return saved;
    const task = await send<Task>(saved ? `/tasks/${saved.id}` : '/tasks', saved ? 'PATCH' : 'POST', nextFields);
    setSaved(task);
    setFields(Object.fromEntries(Object.keys(emptyFields).map((key) => [key, task[key as keyof TaskFields]])) as TaskFields);
    refresh();
    return task;
  }
  async function generateQuestions() {
    setGenerating('questions');
    try {
      const result = await requestQuestions({ title: fields.title, initial_description: fields.initial_description }, questions.map(({ field, question }) => ({ field, question })));
      setActiveQuestions(questions.map((item) => ({ ...item, question: result.questions.find((question) => question.field === item.field)!.question })));
      setQuestionInfo(result); setHasQuestions(true);
      setQuestionsIdea(JSON.stringify([fields.title, fields.initial_description]));
    } finally { setGenerating(null); }
  }
  async function generateCard() {
    setGenerating('card');
    try {
      const result = await requestCard({ title: fields.title, initial_description: fields.initial_description },
        activeQuestions.map(({ field, question }) => ({ field, question })), answers);
      setFields(result.card); setCardInfo(result); setHasCard(true);
      await save(result.card);
    } finally { setGenerating(null); }
  }
  async function go(next: number) {
    await save();
    if (step === 1 && next === 2 && !hasQuestions) await generateQuestions();
    if (step === 2 && next === 3 && !hasCard) await generateCard();
    setStep(next);
  }
  async function confirm() {
    const task = await save();
    const result = await send<Task>(`/tasks/${task.id}/confirm`, 'POST');
    setSaved(result); refresh(); notify('Карточка подтверждена. Рейтинг рассчитан.');
    navigate(`task/${result.id}`);
  }
  function field(key: keyof TaskFields, label: string, description?: string, answer = false) {
    const value = answer ? answers[key as keyof Answers] : fields[key];
    const onChange = (text: string) => {
      if (answer) setAnswers((current) => ({ ...current, [key]: text }));
      change(key, text);
    };
    return <div className="field" key={key}><label htmlFor={`task-field-${key}`}><span>{label}{(key === 'title' || key === 'initial_description') && <span className="required"> *</span>}</span></label>
      {description && <small>{description}</small>}
      {key === 'title' ? <input id={`task-field-${key}`} name={key} value={value} maxLength={200} required onChange={(event) => onChange(event.target.value)} placeholder="Например, анализ отзывов клиентов" />
        : <textarea id={`task-field-${key}`} name={key} value={value} rows={key === 'initial_description' ? 3 : 4} maxLength={10000} required={key === 'initial_description'} onChange={(event) => onChange(event.target.value)} placeholder="Введите информацию, которой располагаете" />}
    </div>;
  }

  return <>
    <div className="page-heading"><div><p className="eyebrow">ОТ ИДЕИ К ПРОЕКТУ</p><h1>{initial ? 'Редактирование задачи' : 'Конструктор задачи'}</h1><p className="muted">Уточните детали, проверьте карточку и подтвердите её перед публикацией.</p></div></div>
    <ol className="steps">{['Идея', 'Уточнения', 'Карточка', 'Подтверждение'].map((label, index) => <li key={label} className={step === index + 1 ? 'active' : step > index + 1 ? 'done' : ''} aria-current={step === index + 1 ? 'step' : undefined}><span>{step > index + 1 ? '✓' : index + 1}</span>{label}</li>)}</ol>
    <form className="panel wizard" onSubmit={(event) => { event.preventDefault(); void run(() => step < 4 ? go(step + 1) : confirm()); }}>
      <fieldset disabled={busy}>
        <div className="section-heading"><h2>{['Расскажите о своей идее', 'Помогите команде понять задачу', 'Проверьте структуру карточки', 'Последние правки и подтверждение'][step - 1]}</h2><span className="muted small">Шаг {step} из 4</span></div>
        {generating && <div className="ai-loading" role="status"><span className="spinner" />{generating === 'questions' ? 'AI готовит уточняющие вопросы…' : 'AI формирует карточку из ваших ответов…'}<small>Обычно это занимает несколько секунд. При недоступности AI включится резервный режим.</small></div>}
        {step === 1 && <>{field('title', 'Название задачи')}{field('initial_description', 'Краткое описание', 'Опишите суть задачи своими словами. Детали уточним на следующем шаге.')}<p className="muted small">При первом нажатии «Далее» название и описание будут отправлены AI для подготовки вопросов.</p></>}
        {step === 2 && <>
          <div className={`info ${questionInfo?.source === 'fallback' ? 'fallback-info' : ''}`} role="status">{questionInfo?.message || 'Используются сохранённые поля и стандартные вопросы. При желании подготовьте вопросы с AI.'} Если сведений пока нет, оставьте поле пустым.</div>
          {questionsIdea !== JSON.stringify([fields.title, fields.initial_description]) && <p className="muted small">Название или описание изменились. При необходимости обновите вопросы явной кнопкой.</p>}
          <button type="button" className="secondary ai-regenerate" onClick={() => void run(async () => { await save(); await generateQuestions(); })}>Сгенерировать вопросы заново</button>
          {activeQuestions.map((question, index) => field(question.field, `${index + 1}. ${question.question}`, `${question.label} · ${question.weight} баллов`, true))}
          {hasCard && <p className="muted small">Карточка уже сформирована. Переход вперёд сохранит правки без повторного AI-запроса; новую генерацию можно запустить на следующем шаге.</p>}
        </>}
        {step === 3 && <>
          <div className={`info ${cardInfo?.source === 'fallback' ? 'fallback-info' : ''}`} role="status">{cardInfo?.message || 'Карточка содержит сохранённые сведения.'} На следующем шаге можно отредактировать любое поле. Публикация выполняется только после вашего подтверждения.</div>
          <p className="muted small">Повторная генерация заменит текст карточки результатом на основе исходных ответов. Ваши ответы на шаге 2 сохранятся.</p>
          <button type="button" className="secondary ai-regenerate" onClick={() => void run(async () => { await save(); await generateCard(); })}>Сформировать карточку заново</button>
          <CardContent fields={fields} />
        </>}
        {step === 4 && <>
          <div className="info">{confirmed ? 'Текущая версия подтверждена.' : 'Проверьте все поля и подтвердите карточку вручную. Любое сохранённое изменение сбрасывает подтверждение.'} {saved?.status === 'published' && 'Сохранение изменений вернёт опубликованную задачу в черновик до повторной публикации.'}</div>
          {field('title', 'Название задачи')}{field('initial_description', 'Краткое описание')}
          {questions.map((question) => field(question.field, question.label))}
        </>}
        <div className="form-footer">
          <div className="actions">{step > 1 && <button type="button" className="secondary" onClick={() => void run(() => go(step - 1))}>Назад</button>}
            <button type="button" className="quiet" onClick={() => void run(async () => { const result = await save(); notify('Черновик сохранён'); navigate(`task/${result.id}`); })}>Сохранить и выйти</button></div>
          <button type="submit">{busy ? generating ? 'Генерируем…' : 'Сохраняем…' : step === 4 ? 'Подтвердить карточку' : step === 2 ? hasCard ? 'Далее к карточке →' : 'Сформировать карточку →' : 'Далее →'}</button>
        </div>
        <p className="muted small">{saved ? `Задача №${saved.id}. ${dirty ? 'Есть несохранённые изменения.' : 'Изменения сохранены.'}` : 'Черновик будет сохранён после первого шага.'} Ответы сохраняются при переходах между шагами.</p>
      </fieldset>
    </form>
  </>;
}
