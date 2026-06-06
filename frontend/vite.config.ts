import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import fs from 'fs'

// Доверенный HTTPS через mkcert (certs/), если сертификаты есть — нужен для установки PWA на телефоне
// (secure-context с доверенным сертификатом). Без них dev поднимется по http (localhost тоже secure-context).
const certDir = 'certs'
const https = fs.existsSync(`${certDir}/key.pem`) && fs.existsSync(`${certDir}/cert.pem`)
  ? { key: fs.readFileSync(`${certDir}/key.pem`), cert: fs.readFileSync(`${certDir}/cert.pem`) }
  : undefined

// Бэкенд проксируется с того же origin, чтобы не было mixed-content (https-страница → http-бэкенд).
const proxy = {
  '/api': { target: 'http://localhost:3001', changeOrigin: true },
  '/ws': { target: 'ws://localhost:3001', ws: true, rewrite: (p: string) => p.replace(/^\/ws/, '') },
}

// https://vite.dev/config/
export default defineConfig({
  server: { host: true, https, proxy },
  // production-сборка (npm run build && npm run preview) — настоящий PWA, тоже по https с прокси
  preview: { host: true, https, proxy },
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // вендоры в отдельные чанки: меняются редко → долго кэшируются, грузятся параллельно с app-кодом
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) return 'react'
          if (id.includes('@xterm')) return 'xterm'
        },
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'app-icon.svg'],
      manifest: {
        name: 'AI Workspace IDE',
        short_name: 'AI Workspace',
        description: 'Браузерный пульт управления агентами: чат, терминалы и git',
        lang: 'ru',
        theme_color: '#1e1e1e',
        background_color: '#1e1e1e',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'app-icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // кэшируем оболочку приложения для офлайн-старта; API/WS бэкенда не трогаем
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: true },
    }),
  ],
})
