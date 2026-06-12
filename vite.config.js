import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  optimizeDeps: {
    include: ['pdfjs-dist/build/pdf.mjs'],
  },
  worker: {
    format: 'es',
  },
})
