import { expect, test, type Page } from '@playwright/test';

async function mockAI(page: Page) {
  const questions = await (await page.request.get('/api/questions')).json();
  await page.route('**/api/ai/questions', (route) => route.fulfill({ json: {
    source: 'ai', reason: null, message: 'Mock AI: вопросы сохранены.',
    questions: questions.map((q: { field: string }) => ({ field: q.field, question: `Индивидуальный вопрос про ${q.field}?` })),
  } }));
  await page.route('**/api/ai/task-card', (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { source: 'ai', reason: null, message: 'Mock AI: карточка готова.',
      card: { title: body.title, initial_description: body.initial_description, ...body.answers, context: 'Формулировка AI' } } });
  });
}
async function newDraft(page: Page, title: string) {
  await mockAI(page);
  await page.goto('/#new');
  await page.getByLabel('Название задачи').fill(title);
  await page.getByLabel('Краткое описание').fill('Первоначальный текст идеи');
  await page.getByRole('button', { name: 'Далее →', exact: true }).click();
  await expect(page.locator('textarea[name="context"]')).toBeVisible();
  await expect(page).toHaveURL(/#new\/\d+$/);
  return Number(new URL(page.url()).hash.split('/')[1]);
}

test('SQLite восстанавливает шаг, вопросы, исходные ответы и карточку без дубликатов', async ({ page, request }) => {
  const id = await newDraft(page, 'Восстановление конструктора');
  await page.locator('textarea[name="context"]').fill('Мой исходный ответ до AI');
  await expect.poll(async () => (await (await request.get(`/api/tasks/${id}`)).json()).wizard_state.answers.context).toBe('Мой исходный ответ до AI');
  // Prove that browser storage is not the source of the restored draft.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.locator('textarea[name="context"]')).toHaveValue('Мой исходный ответ до AI');
  await expect(page.getByText('1. Индивидуальный вопрос про context?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Сформировать карточку →', exact: true }).click();
  await expect(page.getByText('Формулировка AI', { exact: true })).toBeVisible();
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.getByText('Шаг 3 из 4')).toBeVisible();
  await expect(page.getByText('Формулировка AI', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.locator('textarea[name="context"]')).toHaveValue('Мой исходный ответ до AI');
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.getByLabel('Краткое описание')).toHaveValue('Первоначальный текст идеи');
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`#new/${id}$`));
  const tasks = await (await request.get('/api/tasks?search=Восстановление конструктора')).json();
  expect(tasks).toHaveLength(1);
  expect(tasks[0].id).toBe(id);
});

test('Навигация, роль и браузер Назад защищены диалогом; сохранённая форма не предупреждает', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Создать задачу' }).click();
  await page.getByLabel('Название задачи').fill('Пока только название');
  await page.getByRole('link', { name: 'Мои задачи', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Продолжить редактирование' }).click();
  await expect(page.getByLabel('Название задачи')).toHaveValue('Пока только название');
  await page.getByRole('button', { name: 'Студент', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Бизнес', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Продолжить редактирование' }).click();
  await page.goBack();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Продолжить редактирование' }).click();
  await expect(page).toHaveURL(/#new$/);
  await page.getByRole('link', { name: 'Мои задачи', exact: true }).click();
  await dialog.getByRole('button', { name: 'Выйти без сохранения' }).click();
  await page.getByRole('link', { name: 'Создать задачу' }).click();
  await expect(page.getByLabel('Название задачи')).toHaveValue('');
  await page.getByLabel('Название задачи').fill('Сохранить при смене роли');
  await page.getByLabel('Краткое описание').fill('Описание для сохранения');
  await page.getByRole('button', { name: 'Студент', exact: true }).click();
  await dialog.getByRole('button', { name: 'Сохранить и выйти' }).click();
  await expect(page.getByRole('heading', { name: 'Каталог задач' })).toBeVisible();
  const tasks = await (await request.get('/api/tasks?search=Сохранить при смене роли')).json();
  expect(tasks).toHaveLength(1);
  await page.getByRole('button', { name: 'Бизнес', exact: true }).click();
  await page.goto(`/#new/${tasks[0].id}`);
  await expect(page.getByLabel('Название задачи')).toHaveValue('Сохранить при смене роли');
  await page.getByRole('link', { name: 'Мои задачи', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Мои задачи', exact: true })).toBeVisible();
});

test('Обновление до автосохранения: beforeunload и аварийное восстановление ввода', async ({ page }) => {
  await page.goto('/#new');
  await page.getByLabel('Название задачи').fill('Ещё без описания');
  let unloads = 0;
  page.on('dialog', async (dialog) => { expect(dialog.type()).toBe('beforeunload'); unloads++; await dialog.accept(); });
  await page.reload();
  await expect(page.getByLabel('Название задачи')).toHaveValue('Ещё без описания');
  expect(unloads).toBe(1);
});

test('Поздний AI после ухода отменён и не перезаписывает ручное изменение', async ({ page, request }) => {
  const id = await newDraft(page, 'Отмена старого AI');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  await page.route('**/api/ai/task-card', async (route) => {
    const body = route.request().postDataJSON(); started(); await gate;
    await route.fulfill({ json: { source: 'ai', reason: null, message: 'Поздно', card: { title: body.title, initial_description: body.initial_description, ...body.answers, context: 'Устаревший AI' } } }).catch(() => {});
  });
  await page.getByRole('button', { name: 'Сформировать карточку →', exact: true }).click();
  await start;
  const aborted = page.waitForEvent('requestfailed', (r) => r.url().endsWith('/api/ai/task-card'));
  await page.getByRole('link', { name: 'Мои задачи', exact: true }).click();
  await aborted;
  const opened = await (await request.get(`/api/tasks/${id}`)).json();
  const latest = await (await request.patch(`/api/tasks/${id}`, { data: { expected_revision: opened.revision, context: 'Новая ручная правка после ухода' } })).json();
  release();
  await page.goto(`/#task/${id}`);
  await expect(page.getByText('Новая ручная правка после ухода', { exact: true })).toBeVisible();
  expect(await (await request.get(`/api/tasks/${id}`)).json()).toEqual(latest);
});

test('AI уже получен, но отложенное сохранение получает 409 после новой ручной правки', async ({ page, request }) => {
  const id = await newDraft(page, 'Конфликт сохранения AI');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  await page.route(`**/api/tasks/${id}/wizard`, async (route) => {
    const body = route.request().postDataJSON();
    if (body.state.fields.context === 'Формулировка AI') {
      started(); await gate;
      const response = await route.fetch();
      expect(response.status()).toBe(409);
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Сформировать карточку →', exact: true }).click();
  await start;
  const opened = await (await request.get(`/api/tasks/${id}`)).json();
  const latest = await (await request.patch(`/api/tasks/${id}`, { data: { expected_revision: opened.revision, context: 'Новая ручная версия' } })).json();
  release();
  await page.getByRole('button', { name: 'Открыть актуальную карточку' }).click();
  await expect(page.getByText('Новая ручная версия', { exact: true })).toBeVisible();
  expect(await (await request.get(`/api/tasks/${id}`)).json()).toEqual(latest);
});

test('Потерянный ответ создания и перезагрузка не создают второй черновик', async ({ page, request }) => {
  let saved!: () => void;
  const stored = new Promise<void>((resolve) => { saved = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/wizard-drafts', async (route) => {
    const response = await route.fetch(); saved(); await gate;
    await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  await page.goto('/#new');
  await page.getByLabel('Название задачи').fill('Потерянный ответ создания');
  await page.getByLabel('Краткое описание').fill('Описание сохранено сервером');
  await stored;
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  release();
  await expect(page).toHaveURL(/#new\/\d+$/);
  await expect(page.getByLabel('Название задачи')).toHaveValue('Потерянный ответ создания');
  expect(await (await request.get('/api/tasks?search=Потерянный ответ создания')).json()).toHaveLength(1);
});

test('Перезагрузка во время сохранения сохраняет более свежий ввод той же вкладки', async ({ page, request }) => {
  const id = await newDraft(page, 'Ввод во время сохранения');
  let stored!: () => void;
  const committed = new Promise<void>((resolve) => { stored = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/tasks/${id}/wizard`, async (route) => {
    const response = await route.fetch(); stored(); await gate;
    await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  await page.locator('textarea[name="context"]').fill('Первый ввод');
  await committed;
  await page.locator('textarea[name="context"]').fill('Более свежий ввод');
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload(); release();
  await expect(page.locator('textarea[name="context"]')).toHaveValue('Более свежий ввод');
  await expect.poll(async () => (await (await request.get(`/api/tasks/${id}`)).json()).context).toBe('Более свежий ввод');
});

test('Перезагрузка при сохранении AI-карточки восстанавливает уже записанный AI-результат', async ({ page, request }) => {
  const id = await newDraft(page, 'Перезагрузка при записи AI');
  let stored!: () => void;
  const committed = new Promise<void>((resolve) => { stored = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/tasks/${id}/wizard`, async (route) => {
    const body = route.request().postDataJSON();
    if (body.state.hasCard) {
      const response = await route.fetch(); stored(); await gate;
      await route.fulfill({ response }).catch(() => {});
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Сформировать карточку →', exact: true }).click();
  await committed;
  await page.reload(); release();
  await expect(page.getByText('Шаг 3 из 4')).toBeVisible();
  await expect(page.getByText('Формулировка AI', { exact: true })).toBeVisible();
  expect((await (await request.get(`/api/tasks/${id}`)).json()).context).toBe('Формулировка AI');
});
