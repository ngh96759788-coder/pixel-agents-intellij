import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    // Remove type="module" and crossorigin for JCEF file:// compatibility
    {
      name: 'jcef-compat',
      enforce: 'post',
      transformIndexHtml(html: string) {
        return html
          .replace(/ type="module"/g, ' defer')
          .replace(/ crossorigin/g, '')
      },
    },
  ],
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    modulePreload: false,
  },
  base: './',
})
