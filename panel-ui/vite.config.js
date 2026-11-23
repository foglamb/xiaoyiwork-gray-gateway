import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

// Build straight into src/panel so the Node server keeps serving plain files
// with no runtime bundler and no extra dependencies at deploy time.
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: resolve(import.meta.dirname, '../src/panel'),
    emptyOutDir: true,
    // Single self-contained bundle: CSP stays script-src 'self' with no eval.
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'app-[hash].js',
        assetFileNames: (info) => (info.names?.some((n) => n.endsWith('.css')) ? 'app.css' : 'asset-[hash][extname]'),
      },
    },
  },
})
