# CLAUDE.md

Гид по проекту для Claude Code. Прочитай это перед началом работы.

## Что это

**AI Workspace IDE** — браузерный **пульт управления агентами** над набором проектов. В каждом проекте: нативный **чат с агентом** на базе `claude` CLI (главный интерфейс), вспомогательные PTY-терминалы (`bash`), git (log / branches / commit / push). Кода в браузере **не редактируем и не просматриваем** — агент сам правит файлы в своей рабочей директории. Есть кросс-проектный «общий менеджер» (overseer).

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
  - **`ChatPanel` (react-markdown + highlight.js) — lazy** — грузится при открытии чата, не на старте (~100 КБ gzip);
  - **`TerminalPanel` (xterm) тоже lazy** — грузится при первом открытии терминала, не на старте;
  - начальная загрузка = только `index` + `react` (~90 КБ gzip), всё тяжёлое отложено;
  - `ChatPanel` и `TerminalPanel` обёрнуты в `memo` — ререндеры `App` не дёргают живые чаты/терминалы; пропсы сравниваются по идентичности.
  - PWA precache ~1 МБ (после удаления Monaco) — оболочка для офлайн-старта.

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
- `workspace.db` — SQLite (better-sqlite3): таблицы `projects`, `users` (логины/роли), `chat_sessions` + `chat_messages` (история чатов, чистится по ретенции), `tg_sessions` (привязки Telegram).

Пути задаются через env (`backend/.env`, есть `.env.example`):
- `DATA_DIR` (по умолчанию `./data`) → внутри `projects/` и `workspace.db`;
- либо точечно `PROJECTS_DIR` / `DB_PATH`;
- `PORT` — порт бэкенда;
- `FRONTEND_DIST` — путь к собранному фронту для прод-раздачи (по умолчанию `../frontend/dist` относительно cwd бэкенда; если папки нет — бэкенд работает в режиме только API+WS);
- `AUTH_SECRET` — секрет для подписи сессионного токена (в проде задать обязательно, иначе небезопасный дефолт);
- `BOOTSTRAP_ADMIN` — сид первого пользователя: `"логин:пароль"` или `"логин:пароль:роль"` (по умолчанию роль `coder`); создаётся при старте, если такого нет;
- `AUTH_COOKIE_SECURE=1` — выставлять флаг `Secure` на cookie (для https);
- `CHAT_RETENTION_MS` / `CHAT_RETENTION_SWEEP_MS` — окно хранения истории чатов (дефолт 7 дн.) и период чистки (дефолт 1 ч).

Хост бэкенда на фронте — `VITE_BACKEND_HOST` / `VITE_BACKEND_PORT` (по умолчанию хост из адреса страницы). См. `frontend/src/config.ts`. **Никаких захардкоженных путей/IP в коде — только env с дефолтами.**

## Backend (`backend/src/`)

- `index.ts` — Express-роуты (`/api/projects/...`: список, создание, clone, delete, git log/branches/commit/push; `/api/workspaces/:wid/terminals` и `/api/workspaces/:wid/chats` — списки живых серверных сессий воркспейса для переподключения) + WebSocket-сервер (чаты + терминалы) + раздача прод-статики. Хелперы: `syncManagerSkills()` (навыки → `PROJECTS_DIR/.claude/skills`), `syncProjectsGuide()` (`backend/PROJECTS_CLAUDE.md` → `PROJECTS_DIR/CLAUDE.md`, правила запуска приложений проектов). Каждый `Term` хранит `workspaceId` (`projectId` или `'overseer'`) и `seq`.
- `agents.ts` — только `PROMPTS`: ролевые системные промпты двух ролей (`manager` / `overseer`). Роль передаётся `claude` флагом `--append-system-prompt`.
- `agent-stream.ts` — **общий раннер агента** в headless-режиме: `runClaude({cwd, prompt, agent, sessionId?, partial?, onEvent})` спавнит `claude -p ... --output-format stream-json` и отдаёт **нормализованные** события (`init` / `tool` / `delta` / `assistant` / `error` / `done`). Единая точка спавна и разбора NDJSON — переиспользуется и `chat.ts`, и `telegram.ts`.
- `chat.ts` — серверные чат-сессии браузера (`Map<chatId, ChatSession>`, источник истины). WS-хендлеры `chat_create` / `chat_send` / `chat_cancel` / `chat_reset` / `chat_close`. История и `session_id` персистятся в `workspace.db` (`chat_messages` + `chat_sessions`) — диалог переживает и переподключение (`chat_restore`), и рестарт бэкенда (поднимается из БД). Ретенция: `pruneOldMessages()` чистит сообщения старше `CHAT_RETENTION_MS` (дефолт 7 дн.) при старте и по таймеру `CHAT_RETENTION_SWEEP_MS` (дефолт 1 ч). GC отвязанных живых сессий через `DETACH_GC_MS`=30 мин. `listChats(wid)` (память + персист с непустой историей) → `/api/workspaces/:wid/chats`.
- `projects.ts` — БД, `listProjects()` (+автообнаружение), `createProject`, `cloneRepo(url)`, `deleteProject(id)` (удаляет папку, потом запись), `getProject`. Экспортирует `PROJECTS_DIR`, `DB_PATH`.
- `git.ts` — обёртки simple-git (`getLog` / `getBranches` / `commitAll` / `pushRepo`) с кэшем.
- `telegram.ts` — опциональный Telegram-бот (long polling). Поднимается из `index.ts`, только если задан `TELEGRAM_BOT_TOKEN`. Те же роли (`PROMPTS`) и проекты, агент запускается через общий `runClaude` (headless): чат привязан к `{ projectId, agent, sessionId }` (таблица `tg_sessions`), контекст — через `--resume`. Команды: `/agent`, `/projects`, `/status`, `/reset`, `/cancel`, `/help`.
- `types.ts` — `WsMessage` и доменные типы.

### WebSocket-протокол

Каждый чат и каждый терминал открывает **своё** WebSocket-соединение. Главное соединение `App.tsx` принимает только бродкасты + шлёт `subscribe` / `*_close`.

**Чат** (`chat.ts`):
- `chat_create` — `{ type:'chat_create', chatId, projectId, agent }`. cwd: overseer → `PROJECTS_DIR`, иначе папка проекта. Ответ `chat_ready`; если сессия жива — плюс `chat_restore { messages }`.
- `chat_send` — `{ chatId, text }`. Сервер спавнит `runClaude` (`--include-partial-messages` → токеновый стрим) и шлёт `chat_event { chatId, event }`, где `event` нормализован: `{kind:'tool',name,arg}` | `{kind:'delta',text}` | `{kind:'assistant',text}` (финал) | `{kind:'error',text}` | `{kind:'done'}`.
- `chat_cancel` (прервать ответ) / `chat_reset` (новый диалог — сброс `--resume` + истории) / `chat_close` (закрыть сессию).

**Терминал** (`bash` в PTY):
- `terminal_create` — `{ projectId, agent?, cols, rows }`. cwd как у чата. Совпал `terminalId` с живой сессией → переподключение (буфер переотдаётся). Ответ `terminal_ready`.
- `terminal_input` / `terminal_resize` → `terminal_data` / `terminal_exit` (по `terminalId`).

Бродкасты: `projects_updated`.

### Агенты и скиллы

Две роли (`PROMPTS` в `agents.ts`): `manager` — инженер-агент проекта, сам пишет/правит код, коммитит, запускает тесты (cwd = папка проекта); `overseer` («Общий менеджер») — cwd = `PROJECTS_DIR`, видит все проекты, сам код не правит, рекомендует открыть агента, умеет клонировать репозитории. Старые ссылки на `coder`/`reviewer` безопасно сваливаются на `manager` (фолбэк в `runClaude`).

### Авторизация и роли пользователей

⚠️ **Две разные «роли», не путать.** (1) *Тип агента* (`manager`/`overseer`) — где работает `claude`. (2) *Роль пользователя* (`coder`/`analyst`/`tester`/`tourist`) — что пользователю можно.

- **`auth.ts`** — пользователи в `workspace.db` (`users`), пароли `scrypt`, сессия — HMAC-токен `{id,exp}` в httpOnly-cookie. Роуты `/api/auth/login` / `logout` / `me` / `users` (создание юзеров — только роль с `user.manage`). `requireAuth` (middleware), `userFromCookieHeader` (для апгрейда WS), `reqUser(req)`.
- **`permissions.ts`** — `can(role, action)` + матрица. Действия: `agent.run`, `terminal.open`, `git.commit`, `git.push`, `project.add`, `project.delete`, `chat.read`, `user.manage`. Роли: `coder` (всё + управление юзерами), `analyst` (агент + чтение), `tester` (агент + терминал + чтение), `tourist` (только чтение).
- **Гейт.** Backend: `/api/*` (кроме `/api/auth/*`) за `requireAuth`; чувствительные роуты — за `gate(action)`; WS — пользователь берётся из cookie при апгрейде (`wsUsers`), `chat_*` требует `agent.run`, `terminal_create` — `terminal.open`. Frontend — **источник истины всё равно сервер**, кнопки лишь скрываются по `can()` (зеркало матрицы в `frontend/src/auth.ts`).
- **Скиллы под роли.** `backend/skills/role-{coder,analyst,tester,tourist}/SKILL.md` синкаются вместе с остальными (`syncManagerSkills`); ролевая надстройка к системному промпту — `ROLE_NOTES` (`agents.ts`) → `runClaude({roleNote})`, роль приходит из `wsUsers` через `handleChatWs`.

Навыки лежат в `backend/skills/<name>/SKILL.md` (формат `.claude/skills`). При старте бэкенда `syncManagerSkills()` копирует их в `PROJECTS_DIR/.claude/skills/`, откуда их подхватывает `claude` у overseer (его cwd = `PROJECTS_DIR`). Новый навык = новая папка в `backend/skills/` + перезапуск бэкенда.

## Frontend (`frontend/src/`)

- `main.tsx` — точка входа: гейт авторизации (`fetchMe`; нет сессии → `Login`, есть → роутинг по `?p=`: `App` / `ProjectPicker`, в оба прокидывается `user`), `axios.defaults.withCredentials = true`.
- `Login.tsx` — форма входа. `auth.ts` — клиент (`login`/`logout`/`fetchMe`) + зеркало матрицы прав (`can`, `roleLabel`).
- `ProjectPicker.tsx` — лаунчер: список проектов (выбор → `?p=<id>` с перезагрузкой), создание нового проекта инлайном, «Добавить репозиторий», вход в общий менеджер (`?p=overseer`), удаление проекта. Каждый проект открывается в своей вкладке браузера.
- `App.tsx` — оркестратор ОДНОГО воркспейса (проп `workspaceId`): состояние, главный WebSocket (бродкасты + `chat_close`/`terminal_close`), API, раскладка (центр + правая панель действий/git). Текущая ветка — компактно в топбаре. Для overseer git-панель скрыта.
- `ChatPanel.tsx` — **нативный чат с агентом** (основной интерфейс): своё WS-соединение, пузыри сообщений, markdown-рендер ответа (`react-markdown` + `remark-gfm` + `rehype-highlight`), чипы вызовов инструментов, токеновый стрим, кнопки «Стоп»/«Новый диалог», селект стандартных команд (фильтруется по роли через `can`), автоскролл. `memo` + lazy.
- `Terminal.tsx` — xterm + FitAddon, своё WS-соединение (сырой `bash`). `memo` + lazy.
- `AddRepoModal.tsx` — добавление репозитория по URL. `ConfirmModal.tsx` / `PromptModal.tsx` — переиспользуемые модалки.
- `theme.ts` — `agentColors` (цвета ролей, инлайном), `AGENTS`, `agentLabel`, `OVERSEER`.
- `config.ts` — `API` / `WS_URL` / `BACKEND_HOST`.

### Модель «один воркспейс = одна вкладка браузера»

Каждая вкладка браузера работает ровно с одним воркспейсом, заданным в URL: `?p=<projectId>` или `?p=overseer`. Переключения проектов внутри страницы НЕТ — «другой проект» открывается в **новой вкладке браузера** (`window.open` на лаунчер). Старого верхнего бара проектов и `switchProject` больше нет.

`tabs: Tab[]` (`Tab = chat | agent | terminal`; `chat` — нативный диалог, `agent` — legacy `claude` в PTY для переподключения к старым сессиям, `terminal` — сырой bash), все вкладки принадлежат текущему воркспейсу, `uid` — стабильный ключ, видна только активная (`activeUid`); **все вкладки смонтированы постоянно**, чтобы фоновые чаты/терминалы не выгружались.

**Сессии чатов/терминалов — источник истины на СЕРВЕРЕ.** При открытии воркспейса `App` запрашивает `GET /api/workspaces/:wid/chats` и `.../terminals` и переподключается ко всем живым сессиям (по `wsId` = серверный id) — работает даже в свежей вкладке браузера с пустым localStorage. В localStorage (ключ `aiws.ws.<wid>`) персистится **только активная вкладка** (`tabKey`). Закрытие вкладки шлёт `chat_close`/`terminal_close` → сессия гасится сразу; разрыв WS без close → сессия живёт (GC через `DETACH_GC_MS`=30 мин).

### Стили — CSS Modules

- `theme.css` — палитра тёмной IDE обычными CSS-переменными в `:root` (`--color-app`, `--color-sidebar`, `--color-edge`, `--color-accent`, `--color-fg`, `--color-muted`, …) + базовый reset (`body`/`#root`). Импортируется в `main.tsx`. Tailwind удалён.
- На каждый компонент — свой `*.module.css` со скоупленными семантическими классами (`s.topbar`, `s.tab`, `s.bubble`). Модалки делят общий `modal.module.css`. Адаптив (выезжающая правая панель, скрытие на десктопе) — `@media (min-width: 1024px)` внутри `App.module.css`.
- **Конвенция:** статичные стили — классы модуля через `s.<class>`; условные — `clsx(s.a, cond && s.b)`; **динамические цвета** (по `agentColors`, точки статуса) — инлайн `style={{...}}`, значения берут `var(--color-…)` из `theme.css`.
- Освежение: скругления, мягкие тени, `transition`, фокус через `:focus { border-color: accent }`, `backdrop-filter: blur` у модалок. Тёмная VS Code-подобная тема.

## Внешние требования

- Node.js 20+, `claude` CLI в `PATH` (для агентов), `git`.

## Подводные камни

- xterm нельзя `fit()` пока его вкладка скрыта (`display:none`, ширина 0) — иначе раскладка ломается; fit вызывается только при ненулевом размере контейнера.
- Колбэки, передаваемые в долгоживущие эффекты (терминал), держи в `ref`, а не в зависимостях эффекта — иначе пересоздаётся xterm.
- Вкладки рендерятся все сразу (скрытые — `display:none`), чтобы фоновые агенты/терминалы не выгружались. Не размонтируй их при переключении проекта.
