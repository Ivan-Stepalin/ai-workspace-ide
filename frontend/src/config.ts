// Подключение к бэкенду.
// По умолчанию — тот же origin: Vite проксирует /api и /ws на бэкенд (см. vite.config.ts).
// Это убирает mixed-content на https и не требует второго сертификата.
// Если задан VITE_BACKEND_HOST — прямое подключение к бэкенду по этому хосту/порту.
const envHost = import.meta.env.VITE_BACKEND_HOST as string | undefined
const envPort = (import.meta.env.VITE_BACKEND_PORT as string) || '3001'
const secure = typeof location !== 'undefined' && location.protocol === 'https:'

export const BACKEND_HOST = envHost || (typeof location !== 'undefined' ? location.hostname : 'localhost')

// API: при прямом подключении — абсолютный URL; иначе пусто → относительные /api/... через прокси
export const API = envHost ? `${secure ? 'https' : 'http'}://${envHost}:${envPort}` : ''

// WebSocket: прямое подключение к бэкенду, либо /ws того же origin (проксируется на бэкенд)
export const WS_URL = envHost
  ? `${secure ? 'wss' : 'ws'}://${envHost}:${envPort}`
  : `${secure ? 'wss' : 'ws'}://${location.host}/ws`
