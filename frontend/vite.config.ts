import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  // HTTPS (самоподписанный) — нужен для secure-context: PWA-установка, service worker, буфер обмена.
  // Бэкенд проксируется с того же origin, чтобы не было mixed-content (https-страница → http-бэкенд).
  server: {
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3001', ws: true, rewrite: p => p.replace(/^\/ws/, '') },
    },
  },
  plugins: [
    basicSsl(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'app-icon.svg'],
      manifest: {
        name: 'AI Workspace IDE',
        short_name: 'AI Workspace',
        description: 'Браузерная IDE с агентами, терминалами, файловым деревом и git',
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
