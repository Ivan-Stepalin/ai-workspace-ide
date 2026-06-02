# CLAUDE.md

Гид по проекту для Claude Code. Прочитай это перед началом работы.

## Что это

**AI Workspace IDE** — браузерная IDE, которая управляет набором отдельных проектов. В каждом проекте: файловое дерево, Monaco-редактор, интегрированные PTY-терминалы, git, сессии агентов на базе `claude` CLI и запуск приложения проекта одной кнопкой. Есть кросс-проектный «общий менеджер».

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

- `index.ts` — Express-роуты (`/api/projects/...`: список, создание, clone, delete, файлы, fs-операции, git log/branches/commit/push, build start/stop) + WebSocket-сервер. Хелперы: `buildRunCommand()` (подбор команды запуска проекта из его `package.json`: `start`→`dev`→`preview`, Vite получает `--host/--port`, иначе статика через python), `killBuild()` (убивает всю группу процессов), `syncManagerSkills()`, `buildOverseerContext()`.
- `agents.ts` — `chat()`: на **каждое сообщение** спавнит `claude --print --dangerously-skip-permissions <prompt>`, стримит stdout чанками. История в памяти `hist` **по `sessionId`**. `PROMPTS` по типам агентов; `clearSession(id)`.
- `projects.ts` — БД, `listProjects()` (+автообнаружение), `createProject`, `cloneRepo(url)`, `deleteProject(id)` (удаляет папку, потом запись), `getProject`. Экспортирует `PROJECTS_DIR`.
- `git.ts` — обёртки simple-git + построение дерева файлов.
- `types.ts` — `WsMessage` и доменные типы.

### WebSocket-протокол

Главное соединение приложения (одно, в `App.tsx`) ведёт чат со всеми агентами; **каждый терминал открывает своё** соединение.

- Чат: клиент шлёт `{ type:'chat', sessionId, agent, message, projectId }`; сервер отвечает `chunk_start` → много `chunk` → `chunk_end`, плюс `agent_status`. **Всё маршрутизируется по `sessionId`.**
- `{ type:'agent_close', sessionId }` — завершить сессию (убить процесс, очистить историю). При разрыве соединения сервер гасит все процессы агентов этого соединения.
- Терминалы: `terminal_create` / `terminal_input` / `terminal_resize` ↔ `terminal_ready` / `terminal_data` / `terminal_exit` (по `terminalId`).
- Бродкасты: `build_status`, `file_changed`, `tree_updated`, `projects_updated`.

### Агенты и скиллы

Типы: `manager` / `coder` / `reviewer` — работают **в папке конкретного проекта**. `overseer` («Общий менеджер») — **кросс-проектный**: cwd = `PROJECTS_DIR`, в промпт подкладывается сводка по всем проектам (`buildOverseerContext`), сам код не правит, рекомендует открыть нужного агента, умеет клонировать репозитории.

Навыки лежат в `backend/skills/<name>/SKILL.md` (формат `.claude/skills`). При старте бэкенда `syncManagerSkills()` копирует их в `PROJECTS_DIR/.claude/skills/`, откуда их подхватывает `claude` CLI у overseer. Новый навык = новая папка в `backend/skills/` + перезапуск бэкенда.

## Frontend (`frontend/src/`)

- `App.tsx` — оркестратор: всё состояние, единый WebSocket, роуты к API, раскладка (3 колонки: проводник | вкладки+контент | git/сервер/действия).
- `AgentSession.tsx` — UI одной сессии агента (чат). `AddRepoModal.tsx` — добавление репозитория по URL с лоадером. `ConfirmModal.tsx` — переиспользуемое подтверждение (используется для удаления проекта). `FileTree.tsx` — дерево файлов с контекстным меню. `Terminal.tsx` — xterm + FitAddon, своё WS-соединение.
- `theme.ts` — `agentColors` (цвета подтипов, применяются **инлайном** динамически), `AGENTS`, `agentLabel`, `OVERSEER`, тип `Message`.
- `config.ts` — `API` / `WS_URL` / `BACKEND_HOST`.

### Модель вкладок и сессий

`tabs: Tab[]`, где `Tab = agent | file | terminal`. Состояние сессий (`messages`, `streaming`, `agentStatus`, `inputs`) индексируется **по `sessionId`** (число, уникальное в рамках сессии приложения). Вкладка `overseer` единственная и **переживает смену проекта** (остальные вкладки проекта при `switchProject` закрываются). Закрытие вкладки агента шлёт `agent_close`.

### Стили — Tailwind CSS v4

- `index.css`: `@import "tailwindcss"` + блок `@theme` с дизайн-токенами палитры (`--color-app`, `--color-sidebar`, `--color-edge`, `--color-accent`, `--color-fg`, `--color-muted`, `--color-mint`, …). Из них Tailwind генерирует утилиты: `bg-app`, `text-fg`, `border-edge`, `text-accent` и т.д.
- Подключён через `@tailwindcss/vite` (CSS-first, без `tailwind.config.js`).
- **Конвенция:** статичные стили — утилитами Tailwind с этими токенами; **динамические цвета** (по `agentColors`, точки статуса, индикатор сервера) — инлайн `style={{...}}`, т.к. значения приходят из JS.
- Освежение: скругления, мягкие тени, `transition`, фокус-кольца, `backdrop-blur` у модалок. Тёмная VS Code-подобная тема.

## Внешние требования

- Node.js 20+, `claude` CLI в `PATH` (для агентов), `python3` (фолбэк-статика для проектов без скрипта запуска).

## Подводные камни

- xterm нельзя `fit()` пока его вкладка скрыта (`display:none`, ширина 0) — иначе раскладка ломается; fit вызывается только при ненулевом размере контейнера.
- Колбэки, передаваемые в долгоживущие эффекты (терминал), держи в `ref`, а не в зависимостях эффекта — иначе пересоздаётся xterm.
- `claude --print` рассматривай как одноразовый процесс на сообщение; контекст между сообщениями держится только через `hist[sessionId]`.
