# CLAUDE.md

Гид по проекту для Claude Code. Прочитай это перед началом работы.

## Что это

**AI Workspace IDE** — браузерная IDE, которая управляет набором отдельных проектов. В каждом проекте: файловое дерево, Monaco-редактор, интегрированные PTY-терминалы, git, сессии агентов на базе `claude` CLI. Есть кросс-проектный «общий менеджер».

Монорепо из двух пакетов:

```
ai-workspace-ide/
├── backend/    # Node + Express + ws (TypeScript, ESM/NodeNext → компиляция в dist/)
├── frontend/   # React 19 + Vite + Tailwind v4
└── package.json  # корневые скрипты install:all / build / dev:backend / dev:frontend
```

## Запуск и сборка

### Dev (разработка)
- **Backend:** `cd backend && npm start` (= `node dist/index.js`, cwd = `backend/`). Слушает `:3001` (HTTP + WebSocket).
- **Frontend:** `cd frontend && npm run dev` (Vite, HMR, `:5173`, проксирует `/api` и `/ws` на `:3001`).
- Удобно из корня: `npm run dev:backend`, `npm run dev:frontend`, `npm run build`, `npm run install:all`.

### Prod (продакшен) — собранная статика
- **`npm start` из корня** = `npm run build` (бэкенд `tsc` + фронт `vite build`) затем `node backend/dist/index.js`.
- Бэкенд при старте проверяет `frontend/dist` (или `FRONTEND_DIST`) и, если он есть, **сам раздаёт собранный фронт** на `:3001` вместе с API/WS — отдельный Vite-процесс не нужен, порт 5173 в проде свободен. Открывай IDE на `:3001`.
- Раздача: хэшированные ассеты (`/assets/*`) — `Cache-Control: immutable` на год; `index.html`/`sw.js` — `no-cache`; SPA-fallback на `index.html` для всех не-`/api/` GET.
- Сборка оптимизирована под минимальный старт:
  - вендоры (`react`, `xterm`) — отдельные кэшируемые чанки (`manualChunks`);
  - **Monaco забандлен локально** (`EditorLazy.tsx` + пакет `monaco-editor`, не CDN) — офлайн и быстрый старт; грузится lazy-чанком только при открытии файла, его языковые web-воркеры (`?worker`) — тоже отдельными чанками;
  - **`TerminalPanel` (xterm) тоже lazy** — грузится при первом открытии терминала/агента, не на старте;
  - начальная загрузка = только `index` + `react` (~90 КБ gzip), всё тяжёлое отложено;
  - `FileTree` и `TerminalPanel` обёрнуты в `memo` — ввод в редакторе (ререндер `App`) не дёргает дерево/живые терминалы. Чтобы memo работал, колбэки в них передаются стабильными по идентичности (`openFileStable` через ref, `refreshTree` напрямую).
  - PWA precache крупный (~12 МБ: Monaco-воркеры) — осознанная плата за офлайн; лимит поднят (`maximumFileSizeToCacheInBytes`).

⚠️ **Главное про разработку:**
- Backend **запускается из скомпилированного `dist/`**, авто-перезагрузки нет. После любой правки в `backend/src/**` нужно `npm run build` (`tsc`) **и перезапустить** процесс — иначе изменения не применятся.
- Frontend на Vite — в dev изменения подхватываются по HMR; для прода нужен `vite build` (бэкенд раздаёт `dist/`, не подхватит правки на лету).
- Меняешь протокол WebSocket — правь **обе** стороны.

🚫 **Порт 5173 — занят самой IDE (веб AI Workspace, Vite).** Порт `3001` — бэкенд IDE.
**Никогда не запускай dev/preview-сервер проекта (или любой другой процесс) на `5173`** —
это уронит/перехватит веб-интерфейс IDE. Для проектов выбирай другой свободный порт
(например, `5174+`): `npm run dev -- --host 0.0.0.0 --port 5174`. То же правило для агентов,
поднимающих приложение проекта в терминале.

📡 **Приложения проектов — всегда на `0.0.0.0`, не на localhost.** IDE крутится на сервере, поэтому
`localhost` внутри сервера не виден из браузера/телефона пользователя. Dev/preview/HTTP-серверы
проектов должны биндиться на все интерфейсы и открываться по сетевому IP машины
(`http://<IP-машины>:<порт>`). Эта инструкция автоматически доставляется агентам: бэкенд при старте
кладёт `backend/PROJECTS_CLAUDE.md` в корень `PROJECTS_DIR` как `CLAUDE.md` (`syncProjectsGuide()`),
и `claude` каждого проекта наследует её (cwd агента — внутри проекта). Менять правило → править
`backend/PROJECTS_CLAUDE.md` + перезапуск бэкенда.

## Данные vs код

Код приложения (этот репозиторий) ≠ данные пользователя. Данные **не коммитятся** (`.gitignore`):
- `PROJECTS_DIR` — папка с проектами; **каждый подкаталог автоматически становится проектом** (автообнаружение в `listProjects()`).
- `workspace.db` — SQLite (better-sqlite3) с таблицей `projects`.

Пути задаются через env (`backend/.env`, есть `.env.example`):
- `DATA_DIR` (по умолчанию `./data`) → внутри `projects/` и `workspace.db`;
- либо точечно `PROJECTS_DIR` / `DB_PATH`;
- `PORT` — порт бэкенда;
- `FRONTEND_DIST` — путь к собранному фронту для прод-раздачи (по умолчанию `../frontend/dist` относительно cwd бэкенда; если папки нет — бэкенд работает в режиме только API+WS).

Хост бэкенда на фронте — `VITE_BACKEND_HOST` / `VITE_BACKEND_PORT` (по умолчанию хост из адреса страницы). См. `frontend/src/config.ts`. **Никаких захардкоженных путей/IP в коде — только env с дефолтами.**

## Backend (`backend/src/`)

- `index.ts` — Express-роуты (`/api/projects/...`: список, создание, clone, delete, файлы, fs-операции, git log/branches/commit/push; `/api/workspaces/:wid/terminals` — список живых серверных сессий воркспейса для переподключения) + WebSocket-сервер (терминалы + агенты) + раздача прод-статики. Хелперы: `syncManagerSkills()` (навыки → `PROJECTS_DIR/.claude/skills`), `syncProjectsGuide()` (`backend/PROJECTS_CLAUDE.md` → `PROJECTS_DIR/CLAUDE.md`, правила запуска приложений проектов). Каждый `Term` хранит `workspaceId` (`projectId` или `'overseer'`) и `seq`.
- `agents.ts` — только `PROMPTS`: ролевые системные промпты агентов. Сами агенты — это интерактивный `claude` в PTY (см. `terminal_create`), роль передаётся флагом `--append-system-prompt`. Отдельного chat-стриминга больше нет.
- `projects.ts` — БД, `listProjects()` (+автообнаружение), `createProject`, `cloneRepo(url)`, `deleteProject(id)` (удаляет папку, потом запись), `getProject`. Экспортирует `PROJECTS_DIR`.
- `git.ts` — обёртки simple-git + построение дерева файлов.
- `telegram.ts` — опциональный Telegram-бот (long polling). Поднимается из `index.ts`, только если задан `TELEGRAM_BOT_TOKEN`. Те же роли (`PROMPTS`) и проекты, но агент запускается в **headless-режиме** (`claude -p --output-format stream-json --resume`), а не в PTY: чат привязывается к `{ projectId, agent, sessionId }` (таблица `tg_sessions` в `workspace.db`), контекст диалога держится через `--resume`. Команды (в т.ч. в меню бота через `setMyCommands`): `/agent`, `/projects`, `/status`, `/reset`, `/cancel`, `/help`.
- `types.ts` — `WsMessage` и доменные типы.

### WebSocket-протокол

Каждый терминал (и каждый агент — это тоже терминал) открывает **своё** WebSocket-соединение. Главное соединение `App.tsx` принимает только бродкасты.

- `terminal_create` — создать PTY: `{ type:'terminal_create', projectId, agent?, cols, rows }`. Если `agent` задан — в PTY запускается интерактивный `claude` с ролью (`--append-system-prompt`) вместо `bash`; для overseer-воркспейса (`agent==='overseer'` или `projectId==='overseer'`) cwd = `PROJECTS_DIR`, иначе папка проекта. Если `terminalId` совпал с живой сессией — переподключение (буфер переотдаётся). Ответ `terminal_ready`.
- `terminal_input` / `terminal_resize` → `terminal_data` / `terminal_exit` (по `terminalId`).
- Бродкасты: `file_changed`, `tree_updated`, `projects_updated`.

### Агенты и скиллы

Агент = **интерактивный `claude` в PTY-терминале** (виден весь нативный процесс Claude Code: размышления, вызовы инструментов). Типы: `manager` / `coder` / `reviewer` — cwd = папка проекта; `overseer` («Общий менеджер») — cwd = `PROJECTS_DIR`, видит все проекты, сам код не правит, рекомендует открыть нужного агента, умеет клонировать репозитории. Роль задаётся ролевым системным промптом из `PROMPTS` (`agents.ts`).

Навыки лежат в `backend/skills/<name>/SKILL.md` (формат `.claude/skills`). При старте бэкенда `syncManagerSkills()` копирует их в `PROJECTS_DIR/.claude/skills/`, откуда их подхватывает `claude` у overseer (его cwd = `PROJECTS_DIR`). Новый навык = новая папка в `backend/skills/` + перезапуск бэкенда.

## Frontend (`frontend/src/`)

- `main.tsx` — точка входа и роутинг: читает `?p=` из URL. Есть `?p=<id>` → рендерит `App` (воркспейс), иначе → `ProjectPicker` (лаунчер). Никаких условных хуков в App.
- `ProjectPicker.tsx` — лаунчер: список проектов (выбор → `?p=<id>` с перезагрузкой), создание нового проекта инлайном, «Добавить репозиторий», вход в общий менеджер (`?p=overseer`), удаление проекта. Каждый проект открывается в своей вкладке браузера.
- `App.tsx` — оркестратор ОДНОГО воркспейса (проп `workspaceId`): состояние, главный WebSocket (бродкасты + `terminal_close`), API, раскладка (3 колонки). Для overseer-воркспейса левая панель (дерево/ветки) и git скрыты.
- `Terminal.tsx` — xterm + FitAddon, своё WS-соединение; проп `agent` → запускает claude нужной роли. Обёрнут в `memo` (ререндеры App не трогают живые терминалы) и lazy-грузится.
- `AddRepoModal.tsx` — добавление репозитория по URL. `ConfirmModal.tsx` — переиспользуемое подтверждение. `FileTree.tsx` — дерево файлов с контекстным меню (`memo`). `EditorLazy.tsx` — lazy-обёртка локального Monaco.
- `theme.ts` — `agentColors` (цвета подтипов, инлайном), `AGENTS`, `agentLabel`, `OVERSEER`.
- `config.ts` — `API` / `WS_URL` / `BACKEND_HOST`.

### Модель «один воркспейс = одна вкладка браузера»

Каждая вкладка браузера работает ровно с одним воркспейсом, заданным в URL: `?p=<projectId>` или `?p=overseer`. Переключения проектов внутри страницы НЕТ — «другой проект» открывается в **новой вкладке браузера** (`window.open` на лаунчер). Старого верхнего бара проектов и `switchProject` больше нет.

`tabs: Tab[]` (`Tab = agent | file | terminal`), все вкладки принадлежат текущему воркспейсу, `uid` — стабильный ключ, видна только активная (`activeUid`); **все вкладки смонтированы постоянно**, чтобы фоновые агенты/терминалы не выгружались.

**Сессии терминалов/агентов — источник истины на СЕРВЕРЕ.** При открытии воркспейса `App` запрашивает `GET /api/workspaces/:wid/terminals` и переподключается ко всем живым PTY (по `wsId` = серверный id) — работает даже в свежей вкладке браузера с пустым localStorage. В localStorage (ключ `aiws.ws.<wid>`) персистятся **только файловые вкладки** + активная вкладка (`tabKey`); терминалы оттуда НЕ берутся. Закрытие вкладки шлёт `terminal_close` → PTY гасится сразу; разрыв WS без close → PTY живёт (GC через `DETACH_GC_MS`=30 мин).

### Стили — Tailwind CSS v4

- `index.css`: `@import "tailwindcss"` + блок `@theme` с дизайн-токенами палитры (`--color-app`, `--color-sidebar`, `--color-edge`, `--color-accent`, `--color-fg`, `--color-muted`, `--color-mint`, …). Из них Tailwind генерирует утилиты: `bg-app`, `text-fg`, `border-edge`, `text-accent` и т.д.
- Подключён через `@tailwindcss/vite` (CSS-first, без `tailwind.config.js`).
- **Конвенция:** статичные стили — утилитами Tailwind с этими токенами; **динамические цвета** (по `agentColors`, точки статуса, индикатор сервера) — инлайн `style={{...}}`, т.к. значения приходят из JS.
- Освежение: скругления, мягкие тени, `transition`, фокус-кольца, `backdrop-blur` у модалок. Тёмная VS Code-подобная тема.

## Внешние требования

- Node.js 20+, `claude` CLI в `PATH` (для агентов), `git`.

## Подводные камни

- xterm нельзя `fit()` пока его вкладка скрыта (`display:none`, ширина 0) — иначе раскладка ломается; fit вызывается только при ненулевом размере контейнера.
- Колбэки, передаваемые в долгоживущие эффекты (терминал), держи в `ref`, а не в зависимостях эффекта — иначе пересоздаётся xterm.
- Вкладки рендерятся все сразу (скрытые — `display:none`), чтобы фоновые агенты/терминалы не выгружались. Не размонтируй их при переключении проекта.
