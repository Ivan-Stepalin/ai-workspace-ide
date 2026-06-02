// Хост/порт бэкенда. По умолчанию берём хост, с которого открыт фронтенд
// (работает где угодно без правок), переопределяется через .env (VITE_BACKEND_HOST/PORT).
const host = (import.meta.env.VITE_BACKEND_HOST as string) || window.location.hostname || 'localhost'
const port = (import.meta.env.VITE_BACKEND_PORT as string) || '3001'

export const BACKEND_HOST = host
export const API = `http://${host}:${port}`
export const WS_URL = `ws://${host}:${port}`
