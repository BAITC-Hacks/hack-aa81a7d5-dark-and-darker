import { expect, test } from '@playwright/test';
import type { CardReview, TaskFields } from '../src/types';

test('AI-сравнение сохраняется в SQLite, неподтверждённые факты не применяются, исходный ответ восстанавливается', async ({ page, request }) => {
  const questions = await (await request.get('/api/questions')).json();
  await page.route('**/api/ai/questions', (route) => route.fulfill({ json: {
    source: 'ai', reason: null, message: 'Mock вопросы', questions: questions.map(({ field, question }: { field: string; question: string }) => ({ field, question })),
  } }));
  await page.route('**/api/ai/task-card', (route) => {
    const input = route.request().postDataJSON();
    const original: TaskFields = { title: input.title, initial_description: input.initial_description, ...input.answers };
    const proposed = { ...original, constraints: 'Срок разработки — 2 недели. Бюджет — 100000 тенге', context: 'Анализируем отзывы клиентов вручную.' };
    const review: CardReview = Object.fromEntries(Object.entries(original).map(([name, value]) => {
      const field = name as keyof TaskFields;
      return [field, { original: value, proposed: proposed[field], requires_review: value !== proposed[field],
        warnings: field === 'constraints' ? ['AI добавил числовые значения. В исходном ответе сроки и бюджет не определены.'] : [] }];
    }));
    return route.fulfill({ json: { source: 'ai', reason: null, message: 'Непроверенные изменения не применены.', card: original, review } });
  });
  await page.goto('/#new');
  await page.getByLabel('Название задачи').fill('Проверка достоверности карточки');
  await page.getByLabel('Краткое описание').fill('Нужен анализ отзывов');
  await page.getByRole('button', { name: 'Далее →', exact: true }).click();
  await page.locator('textarea[name="context"]').fill('Отзывы разбираем вручную');
  await page.locator('textarea[name="constraints"]').fill('Сроки и бюджет пока не определены');
  await page.getByRole('button', { name: 'Сформировать карточку →', exact: true }).click();
  await expect(page.locator('.ai-review details')).toHaveCount(9);
  const id = Number(new URL(page.url()).hash.split('/')[1]);
  const stored = async () => (await (await request.get(`/api/tasks/${id}`)).json());
  expect((await stored()).constraints).toBe('Сроки и бюджет пока не определены');
  expect((await stored()).context).toBe('Отзывы разбираем вручную');
  expect((await stored()).is_confirmed).toBe(false);
  const constraints = page.locator('[data-review-field="constraints"]');
  await constraints.locator('summary').click();
  await expect(constraints).toContainText('AI добавил числовые значения');
  await expect(constraints).toContainText('Срок разработки — 2 недели. Бюджет — 100000 тенге');
  const context = page.locator('[data-review-field="context"]');
  await context.locator('summary').click();
  await context.getByRole('button', { name: 'Проверил: использовать AI-редакцию' }).click();
  await expect.poll(async () => (await stored()).context).toBe('Анализируем отзывы клиентов вручную.');
  expect((await stored()).is_confirmed).toBe(false);
  // The server, not browser storage, must retain both versions and warnings.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await context.locator('summary').click();
  await expect(context).toContainText('Отзывы разбираем вручную');
  await expect(context).toContainText('Анализируем отзывы клиентов вручную.');
  await context.getByRole('button', { name: 'Восстановить исходный ответ' }).click();
  await expect.poll(async () => (await stored()).context).toBe('Отзывы разбираем вручную');
  await page.getByRole('button', { name: 'Далее →', exact: true }).click();
  await page.getByLabel('Ограничения', { exact: true }).fill('Срок уточнили: 3 недели');
  await page.getByRole('button', { name: 'Подтвердить карточку', exact: true }).click();
  await expect(page.getByText('Карточка подтверждена', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await constraints.locator('summary').click();
  await constraints.getByRole('button', { name: 'Восстановить исходный ответ' }).click();
  await expect(page.getByLabel('Ограничения', { exact: true })).toHaveValue('Сроки и бюджет пока не определены');
  await expect.poll(async () => (await stored()).is_confirmed).toBe(false);
  expect((await stored()).wizard_state.answers.constraints).toBe('Сроки и бюджет пока не определены');
  expect((await stored()).wizard_state.cardReview.constraints.proposed).toContain('100000');
});
