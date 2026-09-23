import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Task } from '../src/types';

const conflictMessage = 'Карточка была изменена в другой вкладке. Откройте актуальную версию и проверьте изменения перед подтверждением.';

async function createTask(request: APIRequestContext, title: string, published = false): Promise<Task> {
  const response = await request.post('/api/tasks', { data: { title, initial_description: 'Версия, которую просмотрел пользователь' } });
  expect(response.status()).toBe(201);
  let task: Task = await response.json();
  if (published) {
    task = await (await request.post(`/api/tasks/${task.id}/confirm`, { data: { expected_revision: task.revision } })).json();
    const result = await request.post(`/api/tasks/${task.id}/publish`, { data: { expected_revision: task.revision } });
    expect(result.status()).toBe(200);
    task = await result.json();
  }
  return task;
}
async function studentTask(page: Page, id: number) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Студент', exact: true }).click();
  await page.goto(`/#task/${id}`);
  await expect(page.getByLabel('Сообщение бизнесу')).toBeVisible();
}

test('Две вкладки: 409 для старой карточки, просмотр новой и ручная публикация с рейтингом 0', async ({ page, context, request }) => {
  const task = await createTask(request, 'Просмотр версии в двух вкладках');
  await page.goto(`/#task/${task.id}`);
  await expect(page.getByText(task.initial_description, { exact: true })).toBeVisible();
  const editor = await context.newPage();
  await editor.goto(`/#edit/${task.id}`);
  await editor.getByLabel('Краткое описание').fill('Актуальная версия из второй вкладки');
  await expect.poll(async () => (await (await request.get(`/api/tasks/${task.id}`)).json()).initial_description).toBe('Актуальная версия из второй вкладки');
  const response = page.waitForResponse((r) => r.url().endsWith(`/tasks/${task.id}/confirm`));
  await page.getByRole('button', { name: 'Подтвердить карточку', exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(page.getByText(conflictMessage, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Подтвердить карточку', exact: true })).toBeDisabled();
  expect((await (await request.get(`/api/tasks/${task.id}`)).json()).is_confirmed).toBe(false);
  await page.getByRole('button', { name: 'Открыть актуальную версию' }).click();
  await expect(page.getByText('Актуальная версия из второй вкладки', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Опубликовать', exact: true })).toBeDisabled();
  expect((await (await request.get(`/api/tasks/${task.id}`)).json()).is_confirmed).toBe(false);
  await page.getByRole('button', { name: 'Подтвердить карточку', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Опубликовать', exact: true })).toBeEnabled();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await expect(page.getByText('Опубликована', { exact: true })).toBeVisible();
  await editor.close();
});

for (const action of ['confirm', 'edit'] as const) {
  test(`Конструктор: устаревшее ${action === 'confirm' ? 'подтверждение' : 'сохранение'} не меняет актуальную карточку`, async ({ page, request }) => {
    const task = await createTask(request, `Версия конструктора: ${action}`);
    await page.goto(`/#edit/${task.id}`);
    await expect(page.getByLabel('Краткое описание')).toHaveValue(task.initial_description);
    const result = await request.patch(`/api/tasks/${task.id}`, { data: { expected_revision: task.revision, initial_description: 'Изменено после открытия конструктора' } });
    expect(result.status()).toBe(200);
    const latest = await result.json();
    if (action === 'edit') {
      await page.getByLabel('Краткое описание').fill('Попытка сохранить старую вкладку');
      await page.getByRole('button', { name: 'Сохранить и выйти', exact: true }).click();
    } else await page.getByRole('button', { name: 'Подтвердить карточку', exact: true }).click();
    await expect(page.locator('.info').getByText(conflictMessage, { exact: true })).toBeVisible();
    expect(await (await request.get(`/api/tasks/${task.id}`)).json()).toEqual(latest);
    await page.getByRole('button', { name: 'Открыть актуальную карточку' }).click();
    await expect(page.getByText('Изменено после открытия конструктора', { exact: true })).toBeVisible();
    expect((await (await request.get(`/api/tasks/${task.id}`)).json()).is_confirmed).toBe(false);
  });
}

test('Старая вкладка не публикует новую версию, подтверждённую в другой вкладке', async ({ page, request }) => {
  const task = await createTask(request, 'Публикация только просмотренной версии');
  const confirmed = await (await request.post(`/api/tasks/${task.id}/confirm`, { data: { expected_revision: task.revision } })).json();
  await page.goto(`/#task/${task.id}`);
  await expect(page.getByRole('button', { name: 'Опубликовать', exact: true })).toBeEnabled();
  const edited = await (await request.patch(`/api/tasks/${task.id}`, { data: { expected_revision: confirmed.revision, initial_description: 'Другая подтверждённая версия' } })).json();
  const latest = await (await request.post(`/api/tasks/${task.id}/confirm`, { data: { expected_revision: edited.revision } })).json();
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await expect(page.getByText(conflictMessage, { exact: true })).toBeVisible();
  expect(await (await request.get(`/api/tasks/${task.id}`)).json()).toEqual(latest);
  await page.getByRole('button', { name: 'Открыть актуальную версию' }).click();
  await expect(page.getByText('Другая подтверждённая версия', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await expect(page.getByText('Опубликована', { exact: true })).toBeVisible();
});

test('Черновики предложений разделены по задаче и команде, переживают переходы и обновление', async ({ page, request }) => {
  const first = await createTask(request, 'Черновики предложений: первая задача', true);
  const second = await createTask(request, 'Черновики предложений: вторая задача', true);
  await studentTask(page, first.id);
  await page.getByLabel('Сообщение бизнесу').fill('Сообщение команды 1');
  await page.getByLabel('Предлагаемое решение').fill('Решение команды 1');
  await page.getByLabel('Демонстрационная команда').selectOption('2');
  await expect(page.getByLabel('Сообщение бизнесу')).toHaveValue('');
  await page.getByLabel('Сообщение бизнесу').fill('Сообщение команды 2');
  await page.getByLabel('Предлагаемое решение').fill('Решение команды 2');
  await page.getByLabel('Демонстрационная команда').selectOption('1');
  await expect(page.getByLabel('Сообщение бизнесу')).toHaveValue('Сообщение команды 1');
  await expect(page.getByLabel('Предлагаемое решение')).toHaveValue('Решение команды 1');
  await page.getByRole('link', { name: 'Каталог', exact: true }).click();
  await page.getByRole('button', { name: second.title, exact: true }).click();
  await expect(page.getByLabel('Сообщение бизнесу')).toHaveValue('');
  await page.getByLabel('Сообщение бизнесу').fill('Черновик для другой задачи');
  await page.goto(`/#task/${first.id}`);
  await expect(page.getByLabel('Сообщение бизнесу')).toHaveValue('Сообщение команды 1');
  await page.reload();
  await expect(page.getByLabel('Предлагаемое решение')).toHaveValue('Решение команды 1');
  await page.getByLabel('Демонстрационная команда').selectOption('2');
  await expect(page.getByLabel('Сообщение бизнесу')).toHaveValue('Сообщение команды 2');
  await expect(page.getByLabel('Предлагаемое решение')).toHaveValue('Решение команды 2');
  expect(await (await request.get(`/api/tasks/${first.id}/proposals`)).json()).toEqual([]);
  expect(await (await request.get(`/api/tasks/${second.id}/proposals`)).json()).toEqual([]);
});

test('Ошибка отправки сохраняет текст; успех очищает только отправленный черновик', async ({ page, request }) => {
  const task = await createTask(request, 'Отправка сохранённого предложения', true);
  await studentTask(page, task.id);
  await page.getByLabel('Демонстрационная команда').selectOption('2');
  await page.getByLabel('Сообщение бизнесу').fill('Оставить черновик команды 2');
  await page.getByLabel('Предлагаемое решение').fill('Неотправленное решение команды 2');
  await page.getByLabel('Демонстрационная команда').selectOption('1');
  await page.getByLabel('Сообщение бизнесу').fill('Отправляем сообщение команды 1');
  await page.getByLabel('Предлагаемое решение').fill('Отправляем решение команды 1');
  await page.route(`**/api/tasks/${task.id}/proposals`, (route) => route.fulfill({ status: 503, json: { detail: 'Тестовая ошибка отправки' } }), { times: 1 });
  await page.getByRole('button', { name: 'Отправить предложение', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Тестовая ошибка отправки');
  await expect(page.getByLabel('Сообщение бизнесу')).toHaveValue('Отправляем сообщение команды 1');
  await expect(page.getByLabel('Предлагаемое решение')).toHaveValue('Отправляем решение команды 1');
  expect(await (await request.get(`/api/tasks/${task.id}/proposals`)).json()).toEqual([]);
  await page.reload();
  await expect(page.getByLabel('Сообщение бизнесу')).toHaveValue('Отправляем сообщение команды 1');
  await page.getByRole('button', { name: 'Отправить предложение', exact: true }).click();
  await expect(page.getByText('На рассмотрении', { exact: true })).toBeVisible();
  expect(await page.evaluate((id) => sessionStorage.getItem(`sana-proposal:${id}:1`), task.id)).toBeNull();
  expect(await page.evaluate((id) => JSON.parse(sessionStorage.getItem(`sana-proposal:${id}:2`) || 'null').message, task.id)).toBe('Оставить черновик команды 2');
  const proposals = await (await request.get(`/api/tasks/${task.id}/proposals`)).json();
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({ team_id: 1, message: 'Отправляем сообщение команды 1', proposed_solution: 'Отправляем решение команды 1', status: 'pending' });
  await page.getByLabel('Демонстрационная команда').selectOption('2');
  await expect(page.getByLabel('Сообщение бизнесу')).toHaveValue('Оставить черновик команды 2');
  await expect(page.getByLabel('Предлагаемое решение')).toHaveValue('Неотправленное решение команды 2');
});
