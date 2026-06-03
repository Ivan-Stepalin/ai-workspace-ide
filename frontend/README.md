# Frontend — AI Workspace IDE

Фронтенд IDE: React 19 + Vite + Tailwind v4, редактор Monaco (локальный, lazy), xterm-терминалы, PWA.

Это часть монорепозитория — общая документация, запуск, сборка и архитектура описаны в
**[корневом README](../README.md)** и **[CLAUDE.md](../CLAUDE.md)**.

Кратко:

```bash
npm run dev        # Vite dev-сервер (HMR), :5173, проксирует /api и /ws на бэкенд :3001
npm run build      # прод-сборка в dist/ (её раздаёт бэкенд на :3001 — см. npm start в корне)
npm run preview    # локальная раздача собранного фронта через Vite preview
npm run lint       # ESLint
```

Точка входа `src/main.tsx` роутит по URL: `?p=<projectId|overseer>` → `App` (воркспейс одного
проекта), иначе → `ProjectPicker` (лаунчер выбора проекта).
