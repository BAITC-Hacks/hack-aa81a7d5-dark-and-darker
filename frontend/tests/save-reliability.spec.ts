import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import type { Task, TaskFields, CardReview } from '../src/types';

const original = 'Нам нужен веб-сервис для анализа отзывов';
const proposed = 'Веб-сервис для автоматизированного анализа отзывов клиентов';
const stored = async (request: APIRequestContext, id: number): Promise<Task> => (await request.get(`/api/tasks/${id}`)).json();
const comparison = (page: Page) => page.locator('[data-review-field=context]');
const chooseAI = (page: Page) => comparison(page).getByRole('button', { name: 'Проверил: использовать AI-редакцию' });
const chooseOriginal = (page: Page) => comparison(page).getByRole('button', { name: 'Восстановить исходный ответ' });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function draft(page: Page, title: string, loseGeneratedResponse = false) {
  const questions = await (await page.request.get('/api/questions')).json();
  await page.route('**/api/ai/questions', (route) => route.fulfill({ json: {
    source: 'ai', reason: null, message: 'Mock вопросы', questions: questions.map(({ field, question }: { field: string; question: string }) => ({ field, question })),
  } }));
  await page.route('**/api/ai/task-card', (route) => {
    const body = route.request().postDataJSON();
    const card: TaskFields = { title: body.title, initial_description: body.initial_description, ...body.answers };
    const ai = { ...card, context: proposed };
    const review: CardReview = Object.fromEntries(Object.entries(card).map(([key, value]) => [key, {
      original: value, proposed: ai[key as keyof TaskFields], requires_review: value !== ai[key as keyof TaskFields], warnings: [],
    }]));
    return route.fulfill({ json: { source: 'ai', reason: null, message: 'Mock сравнение', card, review } });
  });
  await page.goto('/#new');
  await page.getByLabel('Название задачи').fill(title);
  await page.getByLabel('Краткое описание').fill('Проверка надёжного сохранения');
  await page.getByRole('button', { name: 'Далее →', exact: true }).click();
  await page.locator('textarea[name=context]').fill(original);
  if (loseGeneratedResponse) {
    await page.route('**/api/tasks/*/wizard', async (route) => {
      if (route.request().postDataJSON().state.hasCard) {
        await route.fetch(); await route.abort('failed');
        await page.unroute('**/api/tasks/*/wizard');
      } else await route.continue();
    });
  }
  await page.getByRole('button', { name: 'Сформировать карточку →', exact: true }).click();
  if (loseGeneratedResponse) await expect(page.getByRole('button', { name: 'Повторить сохранение' })).toBeVisible();
  else await comparison(page).locator('summary').click();
  return Number(new URL(page.url()).hash.split('/')[1]);
}

test('Быстрый возврат к оригиналу сохраняется в SQLite последовательной записью и переживает reload', async ({ page, request }) => {
  const id = await draft(page, 'Последний выбор побеждает');
  const release = gate(); const started = gate();
  let writes = 0;
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().endsWith(`/tasks/${id}/wizard`)) writes++; });
  await page.route(`**/api/tasks/${id}/wizard`, async (route) => {
    const response = await route.fetch(); started.resolve(); await release.promise;
    await route.fulfill({ response });
  }, { times: 1 });
  await chooseAI(page).click(); await started.promise;
  expect((await stored(request, id)).context).toBe(proposed);
  await chooseOriginal(page).click();
  await page.waitForTimeout(1000); // More than the debounce: no competing write while the first is pending.
  expect(writes).toBe(1);
  release.resolve();
  await expect.poll(async () => (await stored(request, id)).context).toBe(original);
  await expect(page.getByText('Изменения сохранены.', { exact: false })).toBeVisible();
  expect(writes).toBe(2);
  await page.waitForTimeout(1000); expect(writes).toBe(2);
  await page.evaluate(() => sessionStorage.clear());
  await page.reload(); await comparison(page).locator('summary').click();
  await expect(comparison(page).getByRole('status')).toHaveText('Используется: Исходный ответ.');
  await expect(chooseOriginal(page)).toBeDisabled();
  expect((await stored(request, id)).wizard_state!.fields.context).toBe(original);
});

test('Потерянный ответ сохранения сгенерированной карточки не откатывает её к шагу ответов', async ({ page, request }) => {
  const id = await draft(page, 'Потерянный ответ новой AI-карточки', true);
  const committed = await stored(request, id);
  expect(committed.wizard_state!.step).toBe(3);
  expect(committed.wizard_state!.hasCard).toBe(true);
  await page.getByRole('button', { name: 'Повторить сохранение' }).click();
  await expect(page.getByText('Шаг 3 из 4')).toBeVisible();
  await expect(page.getByText('Изменения сохранены.', { exact: false })).toBeVisible();
  expect(await stored(request, id)).toEqual(committed);
});

test('Тайм-аут сохранения оставляет ввод для ручного повтора и не создаёт цикл запросов', async ({ page, request }) => {
  const id = await draft(page, 'Тайм-аут записи');
  await page.clock.install();
  const release = gate(); const started = gate();
  let writes = 0;
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().endsWith(`/tasks/${id}/wizard`)) writes++; });
  await page.route(`**/api/tasks/${id}/wizard`, async (route) => {
    started.resolve(); await release.promise; await route.abort().catch(() => {});
  }, { times: 1 });
  await chooseAI(page).click(); await page.clock.runFor(850); await started.promise;
  await page.clock.fastForward(30_000);
  await expect(page.getByText('Сервер не ответил за 30 секунд.', { exact: false })).toBeVisible();
  await expect(comparison(page).getByRole('status')).toHaveText('Используется: AI-редакция.');
  await page.clock.fastForward(60_000); expect(writes).toBe(1);
  release.resolve();
  await page.getByRole('button', { name: 'Повторить сохранение' }).click();
  await expect.poll(async () => (await stored(request, id)).context).toBe(proposed);
  await expect(page.getByText('Изменения сохранены.', { exact: false })).toBeVisible();
  expect(writes).toBe(2);
});

test('Новая ручная правка после потерянного AI-сохранения переживает немедленный reload', async ({ page, request }) => {
  const id = await draft(page, 'Ручная правка после потери AI-ответа', true);
  await page.locator('textarea[name=context]').fill('Новый ответ важнее предыдущей генерации');
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(page.locator('textarea[name=context]')).toHaveValue('Новый ответ важнее предыдущей генерации');
  await expect.poll(async () => (await stored(request, id)).context).toBe('Новый ответ важнее предыдущей генерации');
  expect((await stored(request, id)).is_confirmed).toBe(false);
});

for (const newerInput of [false, true]) {
  test(`Потеря ответа: точный повтор без 409, более свежий ввод ${newerInput}`, async ({ page, request }) => {
    const id = await draft(page, `Потеря ответа ${newerInput}`);
    const operations: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().endsWith(`/tasks/${id}/wizard`)) operations.push(r.postDataJSON().operation_id); });
    await page.route(`**/api/tasks/${id}/wizard`, async (route) => {
      await route.fetch(); await route.abort('failed');
    }, { times: 1 });
    await chooseAI(page).click();
    await expect(page.getByRole('button', { name: 'Повторить сохранение' })).toBeVisible();
    const committed = await stored(request, id);
    expect(committed.context).toBe(proposed);
    await page.waitForTimeout(1000); expect(operations).toHaveLength(1); // No retry loop.
    if (newerInput) await chooseOriginal(page).click();
    await page.getByRole('button', { name: 'Повторить сохранение' }).click();
    await expect(page.getByText('Изменения сохранены.', { exact: false })).toBeVisible();
    const latest = await stored(request, id);
    expect(latest.context).toBe(newerInput ? original : proposed);
    expect(latest.revision).toBe(committed.revision + (newerInput ? 1 : 0));
    expect(latest.is_confirmed).toBe(false);
    expect(operations[0]).toBe(operations[1]);
    expect(operations).toHaveLength(newerInput ? 3 : 2);
    await expect(page.getByRole('button', { name: 'Открыть актуальную карточку' })).toHaveCount(0);
    await page.evaluate(() => sessionStorage.clear()); await page.reload();
    expect((await stored(request, id)).context).toBe(newerInput ? original : proposed);
  });
}

test('Потерянный ответ и реальная вторая вкладка: повтор получает 409 и не перезаписывает правку', async ({ page, context, request }) => {
  const id = await draft(page, 'Настоящий конфликт после потери ответа');
  await page.route(`**/api/tasks/${id}/wizard`, async (route) => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
  await chooseAI(page).click();
  await expect(page.getByRole('button', { name: 'Повторить сохранение' })).toBeVisible();
  const second = await context.newPage();
  await second.goto(`/#new/${id}`);
  await second.getByRole('button', { name: 'Далее →', exact: true }).click();
  await second.getByLabel('Контекст и потребность', { exact: true }).fill('Правка во второй вкладке');
  await expect.poll(async () => (await stored(request, id)).context).toBe('Правка во второй вкладке');
  const latest = await stored(request, id);
  const conflict = page.waitForResponse((r) => r.url().endsWith(`/tasks/${id}/wizard`) && r.status() === 409);
  await page.getByRole('button', { name: 'Повторить сохранение' }).click(); await conflict;
  await expect(page.getByRole('button', { name: 'Открыть актуальную карточку' })).toBeVisible();
  expect(await stored(request, id)).toEqual(latest);
  await page.getByRole('button', { name: 'Открыть актуальную карточку' }).click();
  await expect(page.getByText('Правка во второй вкладке', { exact: true })).toBeVisible();
});

for (const committed of [false, true]) {
  test(`Выход при зависшем сохранении ограничен по времени, запись уже выполнена: ${committed}`, async ({ page, request }) => {
    const id = await draft(page, `Выход без ожидания ${committed}`);
    const release = gate(); const started = gate(); const finished = gate();
    let writes = 0;
    const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().endsWith(`/tasks/${id}/wizard`)) writes++; });
    await page.route(`**/api/tasks/${id}/wizard`, async (route) => {
      const response = committed ? await route.fetch() : undefined;
      started.resolve(); await release.promise;
      if (response) await route.fulfill({ response }).catch(() => {});
      else await route.abort().catch(() => {});
      finished.resolve();
    }, { times: 1 });
    await chooseAI(page).click(); await started.promise;
    await chooseOriginal(page).click();
    await page.getByRole('link', { name: 'Мои задачи', exact: true }).click();
    const aborted = page.waitForEvent('requestfailed', (r) => r.url().endsWith(`/tasks/${id}/wizard`));
    await page.getByRole('dialog').getByRole('button', { name: 'Выйти без сохранения' }).click();
    await expect(page.getByRole('heading', { name: 'Мои задачи', exact: true })).toBeVisible({ timeout: 3000 });
    await aborted;
    release.resolve(); await finished.promise;
    await page.waitForTimeout(1000);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes).toBe(1); expect(errors).toEqual([]);
    expect((await stored(request, id)).context).toBe(committed ? proposed : original);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), `sana-wizard:${id}`)).toBeNull();
    await page.goto(`/#new/${id}`); await comparison(page).locator('summary').click();
    await expect(comparison(page).getByRole('status')).toHaveText(`Используется: ${committed ? 'AI-редакция' : 'Исходный ответ'}.`);
  });
}

test('AI-выбор виден, ручная правка распознаётся, подтверждение, публикация и предложение работают', async ({ page, request }) => {
  const id = await draft(page, 'Проверка выбора и публикации');
  await expect(chooseOriginal(page)).toBeDisabled();
  await chooseAI(page).click();
  await expect(page.getByText('AI-редакция применена', { exact: true })).toBeVisible();
  await expect(chooseAI(page)).toBeDisabled();
  await expect(chooseAI(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(comparison(page).getByRole('status')).toHaveText('Используется: AI-редакция.');
  await expect(comparison(page)).not.toContainText('Требует проверки');
  await expect.poll(async () => (await stored(request, id)).context).toBe(proposed);
  await page.evaluate(() => sessionStorage.clear()); await page.reload();
  await comparison(page).locator('summary').click();
  await expect(chooseAI(page)).toBeDisabled();
  await chooseOriginal(page).click();
  await expect(page.getByText('Исходный ответ восстановлен', { exact: true })).toBeVisible();
  await expect.poll(async () => (await stored(request, id)).context).toBe(original);
  const same = page.locator('[data-review-field=materials]'); await same.locator('summary').click();
  await expect(same).toContainText('Исходный ответ и AI-редакция совпадают.');
  await expect(same.getByRole('button', { name: 'Восстановить исходный ответ' })).toBeDisabled();
  await expect(same.getByRole('button', { name: 'Проверил: использовать AI-редакцию' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Далее →', exact: true }).click();
  await page.getByLabel('Контекст и потребность', { exact: true }).fill('Ручная правка');
  await expect(comparison(page).getByRole('status')).toHaveText('Используется: Ручная правка.');
  await expect.poll(async () => (await stored(request, id)).context).toBe('Ручная правка');
  await page.evaluate(() => sessionStorage.clear()); await page.reload();
  await comparison(page).locator('summary').click();
  await expect(comparison(page).getByRole('status')).toHaveText('Используется: Ручная правка.');
  await page.getByRole('button', { name: 'Подтвердить карточку', exact: true }).click();
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  expect((await stored(request, id)).status).toBe('published');
  await page.getByRole('button', { name: 'Студент', exact: true }).click();
  await page.goto(`/#task/${id}`);
  await page.getByLabel('Сообщение бизнесу').fill('Готовы обсудить задачу');
  await page.getByLabel('Предлагаемое решение').fill('Разработаем прототип');
  await page.getByRole('button', { name: 'Отправить предложение', exact: true }).click();
  await expect(page.getByText('На рассмотрении', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Бизнес', exact: true }).click();
  await page.goto(`/#task/${id}`);
  await page.getByRole('button', { name: 'Принять', exact: true }).click();
  await expect(page.getByText('Принято', { exact: true })).toBeVisible();
});
