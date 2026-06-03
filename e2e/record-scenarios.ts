import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import path from 'path'
import { execSync } from 'child_process'
import fs from 'fs'

const BASE = process.env.IDE_URL || 'http://localhost:3001'
const OUT  = path.resolve('e2e/videos')
fs.mkdirSync(OUT, { recursive: true })

const VP = { width: 1400, height: 860 }

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

async function typeSlowly(page: Page, text: string, ms = 70) {
  for (const ch of text) { await page.keyboard.type(ch); await delay(ms) }
}

async function newCtx(browser: Browser, label: string): Promise<[BrowserContext, Page]> {
  const ctx = await browser.newContext({
    viewport: VP,
    recordVideo: { dir: path.join(OUT, 'raw'), size: VP },
  })
  const page = await ctx.newPage()
  ;(ctx as any).__label = label
  return [ctx, page]
}

async function save(ctx: BrowserContext) {
  const label = (ctx as any).__label as string
  const video = await (await ctx.pages()[0]?.video()?.path() ?? Promise.resolve(null))
  await ctx.close()
  if (video && label) {
    const dst = path.join(OUT, 'raw', `${label}.webm`)
    if (fs.existsSync(video) && video !== dst) fs.renameSync(video, dst)
  }
}

// ─── Сценарий 1: Лаунчер — обзор и создание проекта ────────────────────────
async function s1_launcher(browser: Browser) {
  console.log('🎬  1/5  Лаунчер — обзор и создание проекта')
  const [ctx, page] = await newCtx(browser, '01-launcher')

  await page.goto(BASE)
  await page.waitForLoadState('networkidle')
  await delay(2000) // осматриваем список проектов

  // Скроллим по списку проектов
  await page.mouse.wheel(0, 200); await delay(600)
  await page.mouse.wheel(0, -200); await delay(800)

  // Жмём «+ Новый проект»
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await delay(600)

  // Вводим имя
  const input = page.getByPlaceholder('название проекта')
  await input.waitFor()
  await typeSlowly(page, 'demo-project')
  await delay(800)

  // Создаём
  await page.getByRole('button', { name: 'Создать' }).click()
  await delay(2500) // ждём появления в списке

  // Удаляем demo-project через API чтобы не засорять
  try {
    const projects = await (await page.request.get(`${BASE}/api/projects`)).json()
    const demo = projects.find((p: any) => p.name === 'demo-project')
    if (demo) await page.request.delete(`${BASE}/api/projects/${demo.id}`)
  } catch { /* ignore */ }

  await delay(500)
  await save(ctx)
  console.log('    ✓')
}

// ─── Сценарий 2: Воркспейс — файловое дерево и Monaco (App.tsx) ─────────────
async function s2_editor(browser: Browser) {
  console.log('🎬  2/5  Воркспейс — файловое дерево + Monaco Editor (App.tsx)')
  const [ctx, page] = await newCtx(browser, '02-editor')

  await page.goto(`${BASE}/?p=wave`)
  await page.waitForLoadState('networkidle')
  await delay(2500)

  // Раскрываем папку src в дереве файлов
  await page.getByText('src').first().click()
  await delay(900)

  // Наводим курсор на App.tsx чтобы было видно hover
  const appTsx = page.getByText('App.tsx').first()
  await appTsx.hover()
  await delay(500)

  // Кликаем — открываем App.tsx в Monaco
  await appTsx.click()
  await delay(3000) // Monaco загружается (lazy chunk)

  // Пауза — показываем открытый файл
  await delay(1500)

  // Скролл вниз по коду
  const editor = page.locator('.monaco-editor').first()
  if (await editor.isVisible({ timeout: 3000 }).catch(() => false)) {
    await editor.click()
    await delay(300)
    for (let i = 0; i < 8; i++) { await page.keyboard.press('PageDown'); await delay(250) }
    await delay(1000)
    // Скролл обратно вверх
    await page.keyboard.press('Control+Home')
    await delay(800)
  }

  await delay(1500)
  await save(ctx)
  console.log('    ✓')
}

// ─── Сценарий 3: Терминал — команды в bash ──────────────────────────────────
async function s3_terminal(browser: Browser) {
  console.log('🎬  3/5  Терминал — bash команды')
  const [ctx, page] = await newCtx(browser, '03-terminal')

  await page.goto(`${BASE}/?p=wave`)
  await page.waitForLoadState('networkidle')
  await delay(2000)

  // Открываем терминал
  await page.getByRole('button', { name: '⌨ Терминал' }).click()
  await delay(1800)

  // Серия команд
  const cmds = [
    'ls -la',
    'cat package.json',
    'git log --oneline -6',
    'git status',
    'node --version && npm --version',
  ]
  for (const cmd of cmds) {
    await typeSlowly(page, cmd, 60)
    await page.keyboard.press('Enter')
    await delay(1200)
  }

  await delay(1000)
  await save(ctx)
  console.log('    ✓')
}

// ─── Сценарий 4: Переподключение сессии ─────────────────────────────────────
async function s4_session_recovery(browser: Browser) {
  console.log('🎬  4/5  Сессия переживает закрытие вкладки')

  // Первая сессия браузера
  const [ctx1, page1] = await newCtx(browser, '04-session-p1')
  await page1.goto(`${BASE}/?p=wave`)
  await page1.waitForLoadState('networkidle')
  await delay(1800)

  await page1.getByRole('button', { name: '⌨ Терминал' }).click()
  await delay(1500)

  await typeSlowly(page1, 'echo "Сессия запущена: $(date)"', 55)
  await page1.keyboard.press('Enter')
  await delay(900)
  await typeSlowly(page1, 'ls src/', 55)
  await page1.keyboard.press('Enter')
  await delay(1000)

  // «Закрываем вкладку» — не шлём terminal_close, просто закрываем контекст
  await save(ctx1)
  await delay(800)

  // Вторая сессия — показываем что терминал восстановлен
  const [ctx2, page2] = await newCtx(browser, '04-session-p2')
  await page2.goto(`${BASE}/?p=wave`)
  await page2.waitForLoadState('networkidle')
  await delay(3000) // ждём восстановления с сервера

  // Видно ту же вкладку терминала с историей
  await delay(1500)

  await typeSlowly(page2, 'echo "Переподключились!"', 60)
  await page2.keyboard.press('Enter')
  await delay(1200)

  await save(ctx2)
  console.log('    ✓')
}

// ─── Сценарий 5: Общий менеджер (Overseer) ──────────────────────────────────
async function s5_overseer(browser: Browser) {
  console.log('🎬  5/5  Общий менеджер — мультипроектный вид')
  const [ctx, page] = await newCtx(browser, '05-overseer')

  // Сначала показываем лаунчер
  await page.goto(BASE)
  await page.waitForLoadState('networkidle')
  await delay(2000)

  // Жмём «Общий менеджер»
  await page.getByText('Общий менеджер').first().click()
  await page.waitForLoadState('networkidle')
  await delay(2500)

  // Открываем терминал внутри Overseer
  await page.getByRole('button', { name: '⌨ Терминал' }).first().click()
  await delay(1500)

  await typeSlowly(page, 'ls', 70)
  await page.keyboard.press('Enter')
  await delay(1000)
  await typeSlowly(page, 'ls wave/', 70)
  await page.keyboard.press('Enter')
  await delay(1200)

  await delay(1500)
  await save(ctx)
  console.log('    ✓')
}

// ─── Конвертация WebM → MP4 ──────────────────────────────────────────────────
async function convertAll() {
  console.log('\n🔄 Конвертация в MP4...')
  const rawDir = path.join(OUT, 'raw')
  const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.webm')).sort()

  for (const f of files) {
    const src = path.join(rawDir, f)
    const name = f.replace('.webm', '')
    const dst = path.join(OUT, `${name}.mp4`)
    try {
      execSync(
        `ffmpeg -y -i "${src}" -vf "scale=${VP.width}:${VP.height}:force_original_aspect_ratio=decrease,pad=${VP.width}:${VP.height}:(ow-iw)/2:(oh-ih)/2:color=1e1e1e" -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -movflags +faststart "${dst}"`,
        { stdio: 'pipe' }
      )
      fs.unlinkSync(src)
      const mb = (fs.statSync(dst).size / 1024 / 1024).toFixed(1)
      console.log(`   ✓ ${name}.mp4  (${mb} МБ)`)
    } catch (e) {
      console.warn(`   ⚠ ${f} — не сконвертировался`)
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
;(async () => {
  console.log(`\n🎥 AI Workspace IDE — запись сценариев\n   → ${BASE}\n   → ${OUT}\n`)
  fs.mkdirSync(path.join(OUT, 'raw'), { recursive: true })

  const browser = await chromium.launch({ headless: true })

  try {
    await s1_launcher(browser)
    await s2_editor(browser)
    await s3_terminal(browser)
    await s4_session_recovery(browser)
    await s5_overseer(browser)
  } finally {
    await browser.close()
  }

  await convertAll()
  console.log(`\n✅ Готово! Видео в ${OUT}/`)
})()
