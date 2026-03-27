import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 배포 시 repo 이름으로 base 설정
// 예: https://username.github.io/pitcher-report/ 이면 base: '/pitcher-report/'
export default defineConfig({
  plugins: [react()],
  base: '/pitcher_report/',
})
