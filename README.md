# AI Workspace IDE

Браузерная IDE с агентами на базе Claude, интегрированными терминалами, файловым деревом, редактором Monaco и git. Управляет отдельными проектами: в каждом можно открывать сколько угодно сессий агентов (менеджер / кодер / ревьюер) и терминалов, запускать приложение проекта одной кнопкой.

```
ai-workspace-ide/
├── backend/    # Node + Express + WebSocket: проекты, git, PTY-терминалы, агенты (claude CLI)
└── frontend/   # React + Vite: IDE-интерфейс
```

Пользовательские данные (проекты и БД) хранятся **вне** репозитория — см. `DATA_DIR` ниже.

## Требования

- Node.js 20+
- [Claude CLI](https://docs.claude.com/claude-code) в `PATH` (бэкенд вызывает `claude` для агентов)
- `python3` (фолбэк-статика для проектов без скрипта запуска)

## Установка

```bash
npm run install:all
# или вручную:
#   npm --prefix backend install
#   npm --prefix frontend install
```

## Настройка

Скопируй примеры окружения и при необходимости поправь:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

- **backend/.env**
  - `PORT` — порт бэкенда (HTTP + WebSocket), по умолчанию `3001`.
  - `DATA_DIR` — где хранить данные (создаются `projects/` и `workspace.db`), по умолчанию `./data`.
    Можно переопределить точечно: `PROJECTS_DIR`, `DB_PATH`.
- **frontend/.env**
  - `VITE_BACKEND_HOST` / `VITE_BACKEND_PORT` — где искать бэкенд. По умолчанию хост берётся
    из адреса, по которому открыт фронтенд, так что для localhost править не нужно.

## Запуск (dev)

В двух терминалах:

```bash
npm run dev:backend     # tsc + node dist/index.js на :3001
npm run dev:frontend    # vite dev-сервер
```

Открой адрес, который покажет Vite.

## Сборка

```bash
npm run build           # собирает backend (tsc) и frontend (vite build)
npm run start:backend   # запуск собранного бэкенда
```
