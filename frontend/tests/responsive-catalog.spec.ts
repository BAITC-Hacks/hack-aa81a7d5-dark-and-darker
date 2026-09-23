import { expect, test, type Page } from '@playwright/test';

async function fits(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const outside = await page.locator('main input, main textarea, main select, main button, nav a, .task-card, .criteria').evaluateAll((elements) => elements.flatMap((element) => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    return rect.left < -1 || rect.right > innerWidth + 1 ? [`${element.tagName}.${element.className}: ${rect.left}..${rect.right}`] : [];
  }));
  expect(outside).toEqual([]);
  expect(await page.evaluate(() => getComputedStyle(document.body).overflowX)).not.toBe('hidden');
  if (page.viewportSize()!.width <= 820) {
    const smallTargets = await page.locator('main button, .role-switch button, nav a').evaluateAll((items) => items.filter((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.height < 44;
    }).map((item) => item.textContent));
    expect(smallTargets).toEqual([]);
  }
}

for (const width of [320, 375, 390, 768, 1440]) {
  test(`Основные страницы и название без пробелов помещаются при ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let task = await (await request.post('/api/tasks', { data: { title: 'М'.repeat(200), initial_description: 'Проверка адаптивности' } })).json();
    task = await (await request.post(`/api/tasks/${task.id}/confirm`, { data: { expected_revision: task.revision } })).json();
    task = await (await request.post(`/api/tasks/${task.id}/publish`, { data: { expected_revision: task.revision } })).json();
    await request.post(`/api/tasks/${task.id}/proposals`, { data: { team_id: 1, message: 'Сообщение'.repeat(35), proposed_solution: 'Решение'.repeat(40) } });
    await page.goto('/');
    await expect(page.locator('.task-card').first()).toBeVisible();
    await fits(page);
    await page.goto(`/#task/${task.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(task.title);
    await expect(page.locator('.criteria > div')).toHaveCount(7);
    await expect(page.locator('.proposal-card')).toBeVisible();
    await fits(page);
    await page.screenshot({ path: `test-results/responsive-${width}-detail.png`, fullPage: true });
    await page.getByRole('link', { name: 'Предложения', exact: true }).click();
    await expect(page.locator('.proposal-card').first()).toBeVisible();
    await fits(page);
    await page.getByRole('link', { name: 'Создать задачу' }).click();
    await expect(page.getByLabel('Название задачи')).toBeVisible();
    await fits(page);
    await page.getByRole('button', { name: 'Студент', exact: true }).click();
    await expect(page.locator('.task-card').first()).toBeVisible();
    await fits(page);
    await page.getByRole('link', { name: 'Команды', exact: true }).click();
    await page.getByRole('button', { name: 'Профиль команды' }).first().click();
    await expect(page.getByRole('heading', { name: 'Профиль команды' })).toBeVisible();
    await fits(page);
    await page.getByRole('link', { name: 'Мои предложения' }).click();
    await expect(page.locator('.proposal-card').first()).toBeVisible();
    await fits(page);
    await page.goto(`/#task/${task.id}`);
    await page.getByLabel('Демонстрационная команда').selectOption('2');
    await expect(page.getByLabel('Предлагаемое решение')).toBeVisible();
    await fits(page);
    expect(errors).toEqual([]);
  });
}

test('Поиск, уровень и сортировка сохраняются при возврате, смене раздела и обновлении, роли изолированы', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Студент', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Поиск задач' });
  const level = page.getByLabel('Уровень готовности');
  const sort = page.getByLabel('Сортировка');
  async function restored() {
    await expect(search).toHaveValue('отзывов');
    await expect(level).toHaveValue('Приоритетная');
    await expect(sort).toHaveValue('score_asc');
    await expect(page.locator('.task-card')).toHaveCount(1);
  }
  await search.fill('отзывов');
  await level.selectOption('Приоритетная');
  await sort.selectOption('score_asc');
  await page.getByRole('button', { name: 'Подробнее' }).click();
  await page.getByRole('button', { name: '← Каталог задач' }).click();
  await restored();
  await page.getByRole('button', { name: 'Подробнее' }).click();
  await page.goBack();
  await restored();
  await page.getByRole('link', { name: 'Команды', exact: true }).click();
  await page.getByRole('link', { name: 'Каталог', exact: true }).click();
  await restored();
  await page.reload();
  await restored();
  await page.getByRole('button', { name: 'Бизнес', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(level).toHaveValue('');
  await expect(sort).toHaveValue('newest');
  await page.getByLabel('Статус задачи').selectOption('draft');
  await search.fill('Другой запрос бизнеса');
  await page.getByRole('button', { name: 'Студент', exact: true }).click();
  await restored();
  await expect(page.getByLabel('Статус задачи')).toHaveCount(0);
  await page.getByRole('button', { name: 'Бизнес', exact: true }).click();
  await expect(search).toHaveValue('Другой запрос бизнеса');
  await expect(page.getByLabel('Статус задачи')).toHaveValue('draft');
  await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
  await page.reload();
  await expect(search).toHaveValue('');
  await expect(page.getByLabel('Статус задачи')).toHaveValue('');
});

test('Мобильный сценарий 320px: конструктор, публикация, предложение и решение бизнеса', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const questions = await (await request.get('/api/questions')).json();
  await page.route('**/api/ai/questions', (route) => route.fulfill({ json: { source: 'ai', reason: null, message: 'Mock вопросы', questions: questions.map(({ field, question }: { field: string; question: string }) => ({ field, question })) } }));
  await page.route('**/api/ai/task-card', (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { source: 'ai', reason: null, message: 'Mock карточка', card: { title: body.title, initial_description: body.initial_description, ...body.answers } } });
  });
  await page.goto('/');
  await page.getByRole('link', { name: 'Создать задачу' }).click();
  await page.getByLabel('Название задачи').fill('Мобильный сценарий 320');
  await page.getByLabel('Краткое описание').fill('Задача для мобильной проверки');
  await page.getByRole('button', { name: 'Далее →', exact: true }).click();
  await page.locator('textarea[name="context"]').fill('Контекст'.repeat(40));
  await fits(page);
  await page.getByRole('button', { name: 'Сформировать карточку →', exact: true }).click();
  await fits(page);
  await page.getByRole('button', { name: 'Далее →', exact: true }).click();
  await fits(page);
  await page.screenshot({ path: 'test-results/responsive-320-wizard.png', fullPage: true });
  await page.getByRole('button', { name: 'Подтвердить карточку', exact: true }).click();
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await expect(page.getByText('Опубликована', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Студент', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Поиск задач' }).fill('Мобильный сценарий 320');
  await page.getByRole('button', { name: 'Подробнее' }).click();
  await page.getByLabel('Сообщение бизнесу').fill('Предлагаем помощь');
  await page.getByLabel('Предлагаемое решение').fill('Наш подход: исследовать задачу и создать прототип');
  await fits(page);
  await page.getByRole('button', { name: 'Отправить предложение', exact: true }).click();
  await expect(page.getByText('На рассмотрении', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Бизнес', exact: true }).click();
  await page.getByRole('link', { name: 'Предложения', exact: true }).click();
  const proposal = page.locator('.proposal-card').filter({ hasText: 'Мобильный сценарий 320' });
  await proposal.getByRole('button', { name: 'Принять', exact: true }).click();
  await expect(proposal.getByText('Принято', { exact: true })).toBeVisible();
  await fits(page);
});

test('Загрузка и ошибка каталога доступны на экране 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/tasks?**', async (route) => { await gate; await route.fulfill({ status: 503, json: {} }); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Мои задачи', exact: true })).toBeVisible();
  await expect(page.getByText('Загружаем данные…', { exact: true })).toBeVisible();
  await fits(page);
  release();
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить данные');
  await fits(page);
  await page.unroute('**/api/tasks?**');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.locator('.task-card').first()).toBeVisible();
  await fits(page);
});
