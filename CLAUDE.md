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

- **Backend:** `cd backend && npm start` (= `node dist/index.js`, cwd = `backend/`). Слушает `:3001` (HTTP + WebSocket).
- **Frontend:** `cd frontend && npm run dev` (Vite, HMR).
- Удобно из корня: `npm run dev:backend`, `npm run dev:frontend`, `npm run build`, `npm run install:all`.

⚠️ **Главное про разработку:**
- Backend **запускается из скомпилированного `dist/`**, авто-перезагрузки нет. После любой правки в `backend/src/**` нужно `npm run build` (`tsc`) **и перезапустить** процесс — иначе изменения не применятся.
- Frontend на Vite — изменения подхватываются по HMR, перезапуск не нужен.
- Меняешь протокол WebSocket — правь **обе** стороны.

## Данные vs код

Код приложения (этот репозиторий) ≠ данные пользователя. Данные **не коммитятся** (`.gitignore`):
- `PROJECTS_DIR` — папка с проектами; **каждый подкаталог автоматически становится проектом** (автообнаружение в `listProjects()`).
- `workspace.db` — SQLite (better-sqlite3) с таблицей `projects`.

Пути задаются через env (`backend/.env`, есть `.env.example`):
- `DATA_DIR` (по умолчанию `./data`) → внутри `projects/` и `workspace.db`;
- либо точечно `PROJECTS_DIR` / `DB_PATH`;
- `PORT` — порт бэкенда.

Хост бэкенда на фронте — `VITE_BACKEND_HOST` / `VITE_BACKEND_PORT` (по умолчанию хост из адреса страницы). См. `frontend/src/config.ts`. **Никаких захардкоженных путей/IP в коде — только env с дефолтами.**

## Backend (`backend/src/`)

- `index.ts` — Express-роуты (`/api/projects/...`: список, создание, clone, delete, файлы, fs-операции, git log/branches/commit/push) + WebSocket-сервер (терминалы + агенты). Хелпер: `syncManagerSkills()`.
- `agents.ts` — только `PROMPTS`: ролевые системные промпты агентов. Сами агенты — это интерактивный `claude` в PTY (см. `terminal_create`), роль передаётся флагом `--append-system-prompt`. Отдельного chat-стриминга больше нет.
- `projects.ts` — БД, `listProjects()` (+автообнаружение), `createProject`, `cloneRepo(url)`, `deleteProject(id)` (удаляет папку, потом запись), `getProject`. Экспортирует `PROJECTS_DIR`.
- `git.ts` — обёртки simple-git + построение дерева файлов.
- `telegram.ts` — опциональный Telegram-бот (long polling). Поднимается из `index.ts`, только если задан `TELEGRAM_BOT_TOKEN`. Те же роли (`PROMPTS`) и проекты, но агент запускается в **headless-режиме** (`claude -p --output-format stream-json --resume`), а не в PTY: чат привязывается к `{ projectId, agent, sessionId }` (таблица `tg_sessions` в `workspace.db`), контекст диалога держится через `--resume`. Команды (в т.ч. в меню бота через `setMyCommands`): `/agent`, `/projects`, `/status`, `/reset`, `/cancel`, `/help`.
- `types.ts` — `WsMessage` и доменные типы.

### WebSocket-протокол

Каждый терминал (и каждый агент — это тоже терминал) открывает **своё** WebSocket-соединение. Главное соединение `App.tsx` принимает только бродкасты.

- `terminal_create` — создать PTY: `{ type:'terminal_create', projectId, agent?, cols, rows }`. Если `agent` задан — в PTY запускается интерактивный `claude` с ролью (`--append-system-prompt`) вместо `bash`; для `overseer` cwd = `PROJECTS_DIR`, иначе папка проекта. Ответ `terminal_ready`.
- `terminal_input` / `terminal_resize` → `terminal_data` / `terminal_exit` (по `terminalId`).
- Бродкасты: `file_changed`, `tree_updated`, `projects_updated`.

### Агенты и скиллы

Агент = **интерактивный `claude` в PTY-терминале** (виден весь нативный процесс Claude Code: размышления, вызовы инструментов). Типы: `manager` / `coder` / `reviewer` — cwd = папка проекта; `overseer` («Общий менеджер») — cwd = `PROJECTS_DIR`, видит все проекты, сам код не правит, рекомендует открыть нужного агента, умеет клонировать репозитории. Роль задаётся ролевым системным промптом из `PROMPTS` (`agents.ts`).

Навыки лежат в `backend/skills/<name>/SKILL.md` (формат `.claude/skills`). При старте бэкенда `syncManagerSkills()` копирует их в `PROJECTS_DIR/.claude/skills/`, откуда их подхватывает `claude` у overseer (его cwd = `PROJECTS_DIR`). Новый навык = новая папка в `backend/skills/` + перезапуск бэкенда.

## Frontend (`frontend/src/`)

- `App.tsx` — оркестратор: всё состояние, главный WebSocket (бродкасты), роуты к API, раскладка (3 колонки: проводник | вкладки+контент | git/сервер/действия).
- `Terminal.tsx` — xterm + FitAddon, своё WS-соединение; проп `agent` → запускает claude нужной роли. Используется и для обычных терминалов, и для агентов.
- `AddRepoModal.tsx` — добавление репозитория по URL (лоадер, авто-имя из ссылки, вставка из буфера). `ConfirmModal.tsx` — переиспользуемое подтверждение (удаление проекта). `FileTree.tsx` — дерево файлов с контекстным меню.
- `theme.ts` — `agentColors` (цвета подтипов, инлайном), `AGENTS`, `agentLabel`, `OVERSEER`.
- `config.ts` — `API` / `WS_URL` / `BACKEND_HOST`.

### Модель вкладок

`tabs: Tab[]`, где `Tab = agent | file | terminal`, у каждой `uid` (стабильный ключ) и `ownerProject` (проект-владелец; `null` = глобальная, напр. общий менеджер). **Все вкладки смонтированы постоянно** — фон не выгружается, поэтому агенты/терминалы продолжают работать при переключении проектов; видна только активная (`activeUid`). Бар показывает вкладки текущего проекта + глобальные. `switchProject` НЕ закрывает вкладки/сессии — лишь меняет активную (запоминается per-project в `lastActiveByProject`). Агент-вкладки — это `TerminalPanel` с пропом `agent`; закрытие вкладки размонтирует панель → её WS закрывается → бэкенд гасит PTY.

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
