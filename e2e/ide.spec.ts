import { test, expect, Page, APIRequestContext } from '@playwright/test'

// Проверяем новую модель: лаунчер → воркспейс → серверные сессии терминалов переживают
// закрытие вкладки браузера и восстанавливаются в свежей сессии (пустой localStorage).

const BASE = process.env.IDE_URL || 'http://localhost:3001'

// Первый существующий проект из API (тесты не зависят от конкретного имени).
async function firstProjectId(request: APIRequestContext): Promise<string> {
  const projects = await (await request.get(`${BASE}/api/projects`)).json()
  if (!projects.length) throw new Error('Нет проектов на сервере — создай хотя бы один для e2e')
  return projects[0].id as string
}

// Чистый старт/уборка: гасим все серверные сессии воркспейса прямо из браузера (через WS /ws).
async function killAllSessions(page: Page, wid: string): Promise<number> {
  return page.evaluate(async (w) => {
    const list: { id: string }[] = await (await fetch(`/api/workspaces/${w}/terminals`)).json()
    if (!list.length) return 0
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    await new Promise<void>((res) => { ws.onopen = () => res() })
    for (const t of list) ws.send(JSON.stringify({ type: 'terminal_close', terminalId: t.id }))
    await new Promise((r) => setTimeout(r, 500))
    ws.close()
    return list.length
  }, wid)
}

const termTabs = (p: Page) => p.getByText(/⌨ Терминал \d+/)  // вкладки терминалов (у кнопки в панели нет номера)

test('лаунчер: показывает выбор проекта и общего менеджера', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'AI Workspace' })).toBeVisible()
  await expect(page.getByText('Общий менеджер')).toBeVisible()
  await expect(page.getByText('ПРОЕКТЫ')).toBeVisible()
})

test('воркспейс проекта открывается с деревом файлов и баром действий', async ({ page, request }) => {
  const wid = await firstProjectId(request)
  await page.goto(`/?p=${wid}`)
  await expect(page.getByText('ПРОВОДНИК')).toBeVisible()
  await expect(page.getByRole('button', { name: '⌨ Терминал' })).toBeVisible()
})

test('сессия терминала живёт на сервере и восстанавливается в новой сессии браузера', async ({ browser, request }) => {
  const wid = await firstProjectId(request)

  // 0) чистый старт — гасим возможные сессии с прошлых прогонов
  const ctx0 = await browser.newContext({ baseURL: BASE })
  const p0 = await ctx0.newPage()
  await p0.goto(`/?p=${wid}`)
  await killAllSessions(p0, wid)
  await ctx0.close()

  // 1) первая сессия браузера: создаём терминал
  const ctx1 = await browser.newContext({ baseURL: BASE })
  const p1 = await ctx1.newPage()
  await p1.goto(`/?p=${wid}`)
  await p1.getByRole('button', { name: '⌨ Терминал' }).click()
  await expect(termTabs(p1)).toHaveCount(1)
  await p1.waitForTimeout(1500)          // дать PTY зарегистрироваться на сервере
  await ctx1.close()                     // закрыли вкладку браузера (WS разорван, terminal_close НЕ слался)

  // 2) сервер всё ещё держит сессию
  const list = await (await request.get(`${BASE}/api/workspaces/${wid}/terminals`)).json()
  expect(list.length).toBe(1)

  // 3) НОВАЯ сессия браузера (пустой localStorage) — терминал восстановлен с сервера
  const ctx2 = await browser.newContext({ baseURL: BASE })
  const p2 = await ctx2.newPage()
  await p2.goto(`/?p=${wid}`)
  await expect(termTabs(p2)).toHaveCount(1)
  await p2.screenshot({ path: 'e2e/__screens__/restored.png', fullPage: true })

  // 4) уборка — гасим сессию
  await killAllSessions(p2, wid)
  await ctx2.close()
})
