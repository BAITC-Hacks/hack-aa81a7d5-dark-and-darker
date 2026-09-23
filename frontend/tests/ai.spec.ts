import { expect, test } from '@playwright/test';

test('AI вызывается только по действию, ответы и ручные правки сохраняются', async ({ page, request }) => {
  const questions = await (await request.get('/api/questions')).json();
  let questionCalls = 0;
  let cardCalls = 0;
  let releaseQuestions!: () => void;
  const gate = new Promise<void>((resolve) => { releaseQuestions = resolve; });
  await page.route('**/api/ai/questions', async (route) => {
    questionCalls++;
    const idea = route.request().postDataJSON();
    expect(idea.title).toBe('Отзывы кофеен');
    await gate;
    await route.fulfill({ json: { source: 'ai', reason: null, message: 'Вопросы подготовлены AI для вашей задачи.',
      questions: questions.map((item: { field: string; question: string }) => ({ field: item.field,
        question: item.field === 'context' ? 'Какие проблемы гостей кофеен нужно выявить в отзывах?' : item.question })) } });
  });
  await page.route('**/api/ai/task-card', async (route) => {
    cardCalls++;
    const body = route.request().postDataJSON();
    expect(body.questions).toHaveLength(7);
    expect(body.answers.context).toBe('хотим разабрать отзывы гостей');
    expect(body.answers.materials).toBe('');
    await route.fulfill({ json: { source: 'ai', reason: null, message: 'AI подготовил карточку. Проверьте формулировки перед подтверждением.',
      card: { title: body.title, initial_description: body.initial_description, ...body.answers,
        context: 'Хотим проанализировать отзывы гостей кофеен.' } } });
  });
  await page.goto('/#new');
  await page.getByLabel('Название задачи').fill('Отзывы кофеен');
  await page.getByLabel('Краткое описание').fill('Нужна аналитика обратной связи гостей.');
  expect(questionCalls).toBe(0);
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page.locator('.ai-loading')).toContainText('AI готовит уточняющие вопросы…');
  releaseQuestions();
  await expect(page.getByText('Какие проблемы гостей кофеен нужно выявить в отзывах?', { exact: false })).toBeVisible();
  await page.locator('textarea[name="context"]').fill('хотим разабрать отзывы гостей');
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page.locator('textarea[name="context"]')).toHaveValue('хотим разабрать отзывы гостей');
  expect(questionCalls).toBe(1);
  await page.getByRole('button', { name: 'Сформировать карточку →', exact: true }).click();
  await expect(page.getByText('Хотим проанализировать отзывы гостей кофеен.', { exact: true })).toBeVisible();
  expect(cardCalls).toBe(1);
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.locator('textarea[name="context"]')).toHaveValue('хотим разабрать отзывы гостей');
  await page.getByRole('button', { name: 'Далее к карточке' }).click();
  await expect(page.getByText('Хотим проанализировать отзывы гостей кофеен.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Далее →', exact: true }).click();
  await page.getByLabel('Контекст и потребность', { exact: true }).fill('Ручная правка после AI');
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.getByText('Ручная правка после AI', { exact: true })).toBeVisible();
  expect(cardCalls).toBe(1);
  await page.getByRole('button', { name: 'Сформировать карточку заново', exact: true }).click();
  await expect(page.getByText('Хотим проанализировать отзывы гостей кофеен.', { exact: true })).toBeVisible();
  expect(cardCalls).toBe(2);
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await page.getByRole('button', { name: 'Сгенерировать вопросы заново' }).click();
  await expect(page.locator('textarea[name="context"]')).toHaveValue('хотим разабрать отзывы гостей');
  expect(questionCalls).toBe(2);
  await page.getByRole('button', { name: 'Далее к карточке' }).click();
  await page.getByRole('button', { name: 'Далее →', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить карточку' }).click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20');
  expect(cardCalls).toBe(2);
  expect(questionCalls).toBe(2);
});

test('Резервный режим backend и сбой AI-запроса в браузере не блокируют публикацию', async ({ page }) => {
  await page.route('**/api/ai/task-card', (route) => route.fulfill({ status: 503, json: { detail: 'Unavailable' } }));
  await page.goto('/#new');
  await page.getByLabel('Название задачи').fill('Резервный сценарий AI');
  await page.getByLabel('Краткое описание').fill('Нужен анализ отзывов, детали уточним позднее.');
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page.locator('.fallback-info')).toContainText('не настроен API-ключ');
  await page.locator('textarea[name="context"]').fill('Исходный ответ, который нельзя потерять');
  await page.getByRole('button', { name: 'Сформировать карточку →', exact: true }).click();
  await expect(page.locator('.fallback-info')).toContainText('резервный режим');
  await expect(page.getByText('Исходный ответ, который нельзя потерять', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.locator('textarea[name="context"]')).toHaveValue('Исходный ответ, который нельзя потерять');
  await page.getByRole('button', { name: 'Далее к карточке' }).click();
  await page.getByRole('button', { name: 'Далее →', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить карточку' }).click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20');
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await expect(page.getByText('Опубликована', { exact: true })).toBeVisible();
});
