import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Images (story 27) : même origine que la page en dev, comme en prod où le serveur
  // sert tout. `secure: false` : cert auto-signé du back-end de dev. `AUDIO_BACK_END`
  // pour viser un autre back-end (ex. serveur de test sur AUDIO_LISTEN).
  server: {
    proxy: {
      '/media': { target: process.env.AUDIO_BACK_END ?? 'https://127.0.0.1:8443', secure: false },
    },
  },
})
