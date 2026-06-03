// Ленивая обёртка над Monaco: грузится отдельным чанком только при открытии файловой вкладки.
// Monaco забандлен ЛОКАЛЬНО (не CDN) — работает офлайн и стартует быстрее; web-воркеры языков
// Vite собирает в отдельные чанки (?worker). Всё это попадает в PWA-precache → офлайн-редактор.
import * as monaco from 'monaco-editor'
import Editor, { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// Monaco ищет воркеры через self.MonacoEnvironment.getWorker (по label языка)
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

// отдаём @monaco-editor/react наш локальный инстанс вместо загрузки с CDN
loader.config({ monaco })

export default Editor
