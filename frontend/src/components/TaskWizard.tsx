import { useState } from 'react';
import { ApiError, send, taskConflictMessage, useResource } from '../api';
import { requestCard, requestQuestions } from '../ai';
import { useAction, useHub } from '../context';
import type { Answers, Task, TaskFields } from '../types';
import { useWizardDraft } from '../wizardDraft';
import { CardContent, ErrorState, Loading } from './ui';

export function TaskWizard({ taskId }: { taskId?: number }) {
  // Assigning an ID with replaceState must not remount the live constructor.
  const [initialId] = useState(taskId);
  const task = useResource<Task>(initialId ? `/tasks/${initialId}` : null);
  if (initialId && task.loading) return <Loading />;
  if (task.error) return <ErrorState message={task.error} retry={task.retry} />;
  return <Wizard initial={task.data} />;
}

function Wizard({ initial }: { initial?: Task }) {
  const { questions, notify, navigate, refresh } = useHub();
  const { busy, run } = useAction();
  const draft = useWizardDraft(initial);
  const { state, update, saved, dirty, save } = draft;
  const { step, fields, answers, hasQuestions, hasCard, questionInfo, cardInfo, questionsIdea } = state;
  const activeQuestions = questions.map((item) => ({ ...item, question: state.questionSet.questions.find((q) => q.field === item.field)!.question }));
  const [generating, setGenerating] = useState<'questions' | 'card' | null>(null);
  const confirmed = !!saved?.is_confirmed && !dirty;

  function change(key: keyof TaskFields, value: string, answer = false) {
    const nextFields = { ...fields, [key]: value };
    update({ fields: nextFields,
      ...(answer ? { answers: { ...answers, [key]: value } } : {}),
      ...(step === 1 ? { originalIdea: { ...state.originalIdea, title: nextFields.title, initial_description: nextFields.initial_description } } : {}),
    });
  }
  async function generateQuestions(nextStep = step) {
    await save();
    const operation = draft.startGeneration();
    setGenerating('questions');
    try {
      const result = await requestQuestions({ title: fields.title, initial_description: fields.initial_description }, questions.map(({ field, question }) => ({ field, question })), operation.signal);
      await operation.apply({ questionSet: { questions: result.questions }, questionInfo: { source: result.source, reason: result.reason, message: result.message },
        hasQuestions: true, questionsIdea: JSON.stringify([fields.title, fields.initial_description]), step: nextStep });
    } finally { operation.finish(); setGenerating(null); }
  }
  async function generateCard(nextStep = step) {
    await save();
    const operation = draft.startGeneration();
    setGenerating('card');
    try {
      const result = await requestCard({ title: state.originalIdea.title, initial_description: state.originalIdea.initial_description }, state.questionSet.questions, answers, operation.signal);
      await operation.apply({ fields: result.card, cardReview: result.review ?? null, cardInfo: { source: result.source, reason: result.reason, message: result.message }, hasCard: true, step: nextStep });
    } finally { operation.finish(); setGenerating(null); }
  }
  async function go(next: number) {
    if (step === 1 && next === 2 && !hasQuestions) await generateQuestions(next);
    else if (step === 2 && next === 3 && !hasCard) await generateCard(next);
    else await draft.move(next);
  }
  async function confirm() {
    try {
      const task = await save();
      const result = await send<Task>(`/tasks/${task.id}/confirm`, 'POST', { expected_revision: task.revision });
      await draft.confirmed(result); refresh(); notify('Карточка подтверждена. Рейтинг рассчитан.');
      navigate(`task/${result.id}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) draft.markConflict();
      else throw error;
    }
  }
  function field(key: keyof TaskFields, label: string, description?: string, answer = false) {
    const value = answer ? answers[key as keyof Answers] : fields[key];
    const onChange = (text: string) => {
      change(key, text, answer);
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
    {draft.conflict && <div className="info fallback-info" role="alert"><p>{taskConflictMessage}</p><button type="button" onClick={() => void draft.openLatest()}>Открыть актуальную карточку</button></div>}
    {draft.saveError && !draft.conflict && <div role="alert" className="info fallback-info">{draft.saveError} Ввод остаётся в форме. <button type="button" onClick={() => void run(async () => { await save(); })}>Повторить сохранение</button></div>}
    <form className="panel wizard" onSubmit={(event) => { event.preventDefault(); void run(() => step < 4 ? go(step + 1) : confirm()); }}>
      <fieldset disabled={busy || draft.conflict}>
        <div className="section-heading"><h2>{['Расскажите о своей идее', 'Помогите команде понять задачу', 'Проверьте структуру карточки', 'Последние правки и подтверждение'][step - 1]}</h2><span className="muted small">Шаг {step} из 4</span></div>
        {generating && <div className="ai-loading" role="status"><span className="spinner" />{generating === 'questions' ? 'AI готовит уточняющие вопросы…' : 'AI формирует карточку из ваших ответов…'}<small>Обычно это занимает несколько секунд. При недоступности AI включится резервный режим.</small></div>}
        {step === 1 && <>{field('title', 'Название задачи')}{field('initial_description', 'Краткое описание', 'Опишите суть задачи своими словами. Детали уточним на следующем шаге.')}<p className="muted small">При первом нажатии «Далее» название и описание будут отправлены AI для подготовки вопросов.</p></>}
        {step === 2 && <>
          <div className={`info ${questionInfo?.source === 'fallback' ? 'fallback-info' : ''}`} role="status">{questionInfo?.message || 'Используются сохранённые поля и стандартные вопросы. При желании подготовьте вопросы с AI.'} Если сведений пока нет, оставьте поле пустым.</div>
          {questionsIdea !== JSON.stringify([fields.title, fields.initial_description]) && <p className="muted small">Название или описание изменились. При необходимости обновите вопросы явной кнопкой.</p>}
          <button type="button" className="secondary ai-regenerate" onClick={() => void run(() => generateQuestions())}>Сгенерировать вопросы заново</button>
          {activeQuestions.map((question, index) => field(question.field, `${index + 1}. ${question.question}`, `${question.label} · ${question.weight} баллов`, true))}
          {hasCard && <p className="muted small">Карточка уже сформирована. Переход вперёд сохранит правки без повторного AI-запроса; новую генерацию можно запустить на следующем шаге.</p>}
        </>}
        {step === 3 && <>
          <div className={`info ${cardInfo?.source === 'fallback' ? 'fallback-info' : ''}`} role="status">{cardInfo?.message || 'Карточка содержит сохранённые сведения.'} На следующем шаге можно отредактировать любое поле. Публикация выполняется только после вашего подтверждения.</div>
          <p className="muted small">Повторная генерация заменит текст карточки результатом на основе исходных ответов. Ваши ответы на шаге 2 сохранятся.</p>
          <button type="button" className="secondary ai-regenerate" onClick={() => void run(() => generateCard())}>Сформировать карточку заново</button>
          <CardContent fields={fields} />
        </>}
        {step === 4 && <>
          <div className="info">{confirmed ? 'Текущая версия подтверждена.' : 'Проверьте все поля и подтвердите карточку вручную. Любое сохранённое изменение сбрасывает подтверждение.'} {saved?.status === 'published' && 'Сохранение изменений вернёт опубликованную задачу в черновик до повторной публикации.'}</div>
          {field('title', 'Название задачи')}{field('initial_description', 'Краткое описание')}
          {questions.map((question) => field(question.field, question.label))}
        </>}
        {step >= 3 && state.cardReview && <section aria-label="Сравнение с AI" className="ai-review">
          <h2>Исходные ответы и редакция AI</h2>
          <p className="muted small">Сравнение последней генерации. Изменение формулировки само по себе не означает ошибку. Смысл новой редакции проверяете вы. Выбор текста не подтверждает карточку.</p>
          {Object.entries(state.cardReview).map(([name, item]) => {
            if (!item) return null;
            const key = name as keyof TaskFields;
            const label = key === 'title' ? 'Название задачи' : key === 'initial_description' ? 'Краткое описание' : questions.find((q) => q.field === key)?.label;
            const originalSelected = fields[key] === item.original;
            const aiSelected = !originalSelected && fields[key] === item.proposed;
            const selected = originalSelected ? 'Исходный ответ' : aiSelected ? 'AI-редакция' : 'Ручная правка';
            const choose = (original: boolean) => {
              change(key, original ? item.original : item.proposed);
              notify(original ? 'Исходный ответ восстановлен' : 'AI-редакция применена');
            };
            return <details key={key} data-review-field={key}>
              <summary>{label} · {selected}</summary>
              <p className="review-selection" role="status">Используется: {selected}.</p>
              {item.warnings.map((warning, index) => <p className="info fallback-info" key={index}>{warning}</p>)}
              {item.requires_review && !aiSelected && <p className="muted small">Перед выбором AI-редакции проверьте сведения в ней.</p>}
              <div className={originalSelected ? 'review-option selected' : 'review-option'}><h4>Исходный ответ</h4><p className="preserve">{item.original || 'Не указан'}</p></div>
              {item.original !== item.proposed
                ? <div className={aiSelected ? 'review-option selected' : 'review-option'}><h4>Предложено AI</h4><p className="preserve">{item.proposed || 'Не указан'}</p></div>
                : <p className="muted small">Исходный ответ и AI-редакция совпадают.</p>}
              <div className="actions">
                <button type="button" className="secondary" disabled={originalSelected} aria-pressed={originalSelected} onClick={() => choose(true)}>Восстановить исходный ответ</button>
                {item.original !== item.proposed && <button type="button" className="secondary" disabled={aiSelected} aria-pressed={aiSelected} onClick={() => choose(false)}>Проверил: использовать AI-редакцию</button>}
              </div>
            </details>;
          })}
        </section>}
        <div className="form-footer">
          <div className="actions">{step > 1 && <button type="button" className="secondary" onClick={() => void run(() => go(step - 1))}>Назад</button>}
            <button type="button" className="quiet" onClick={() => void run(async () => { const result = await save(); notify('Черновик сохранён'); navigate(`task/${result.id}`); })}>Сохранить и выйти</button></div>
          <button type="submit">{busy ? generating ? 'Генерируем…' : 'Сохраняем…' : step === 4 ? 'Подтвердить карточку' : step === 2 ? hasCard ? 'Далее к карточке →' : 'Сформировать карточку →' : 'Далее →'}</button>
        </div>
        <p className="muted small">{saved ? `Задача №${saved.id}. ${draft.saving ? 'Сохраняем…' : dirty ? 'Есть несохранённые изменения.' : 'Изменения сохранены.'}` : 'Черновик сохраняется после заполнения названия и описания.'} Изменения автоматически сохраняются во время ввода.</p>
      </fieldset>
    </form>
  </>;
}
