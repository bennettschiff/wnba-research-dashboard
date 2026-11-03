import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/wnba-stats': {
        target: 'https://stats.wnba.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wnba-stats/, ''),
        headers: {
          'Host': 'stats.wnba.com',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.5',
          'x-nba-stats-origin': 'stats',
          'x-nba-stats-token': 'true',
          'Origin': 'https://stats.wnba.com',
          'Referer': 'https://www.wnba.com/',
        }
      },
      '/cdn-wnba': {
        target: 'https://cdn.wnba.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cdn-wnba/, ''),
      },
      '/espn-site': {
        target: 'https://site.api.espn.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/espn-site/, ''),
      },
      '/espn-core': {
        target: 'https://sports.core.api.espn.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/espn-core/, ''),
      },
      '/espn-web': {
        target: 'https://site.web.api.espn.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/espn-web/, ''),
      },
    }
  }
})
