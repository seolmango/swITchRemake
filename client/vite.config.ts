import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      shared: fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      // 인게임 서버로 직결하지 않는다. 게이트웨이가 경로를 보고 어느 서버인지 정한다 —
      // 서버가 몇 대든, 방금 늘었든 줄었든 여기는 그대로다.
      '/game-ws': {
        target: 'ws://localhost:4100',
        ws: true,
      },
      '/map-bundles': {
        target: 'http://localhost:4100',
        changeOrigin: true,
      },
    },
  },
})
