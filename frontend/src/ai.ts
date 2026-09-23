import { api } from './api';
import type { AIQuestion, Answers, CardResult, QuestionsResult, TaskFields } from './types';

async function generate<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(55000), ...(signal ? [signal] : [])]) });
}

const networkMessage = 'Сервис генерации недоступен. Включён резервный режим. Введённые сведения сохранены.';

export async function requestQuestions(idea: Pick<TaskFields, 'title' | 'initial_description'>, fallback: AIQuestion[], signal?: AbortSignal): Promise<QuestionsResult> {
  try {
    const result = await generate<QuestionsResult>('/ai/questions', idea, signal);
    if (result.questions.length !== 7 || new Set(result.questions.map((item) => item.field)).size !== 7 ||
        !fallback.every((expected) => result.questions.some((item) => item.field === expected.field && item.question.trim()))) {
      throw new Error('Invalid questions');
    }
    return result;
  } catch {
    if (signal?.aborted) throw new DOMException('Генерация отменена', 'AbortError');
    return { source: 'fallback', reason: 'connection', message: networkMessage + ' Используем стандартные вопросы.', questions: fallback };
  }
}

export async function requestCard(idea: Pick<TaskFields, 'title' | 'initial_description'>, questions: AIQuestion[], answers: Answers, signal?: AbortSignal): Promise<CardResult> {
  const fallback: TaskFields = { ...idea, ...answers };
  try {
    const result = await generate<CardResult>('/ai/task-card', { ...idea, questions, answers }, signal);
    if (!Object.keys(fallback).every((key) => typeof result.card[key as keyof TaskFields] === 'string') ||
        !result.card.title.trim() || !result.card.initial_description.trim()) throw new Error('Invalid card');
    return result;
  } catch {
    if (signal?.aborted) throw new DOMException('Генерация отменена', 'AbortError');
    return { source: 'fallback', reason: 'connection', message: networkMessage + ' Карточка собрана из ваших ответов.', card: fallback };
  }
}
