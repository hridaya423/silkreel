import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  site: 'https://silkreel.hridya.tech',
  integrations: [sitemap({ lastmod: new Date() })],
  prefetch: { prefetchAll: true, defaultStrategy: 'viewport' },
  build: { inlineStylesheets: 'auto' },
  vite: {
    plugins: [{
      name: 'separate-dependency-caches',
      config: (_, { mode }) => ({ cacheDir: fileURLToPath(new URL(`./node_modules/.vite/${mode}/`, import.meta.url)) })
    }],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('/node_modules/@remotion/') || id.includes('/node_modules/remotion/')) return 'remotion'
            if (id.includes('/packages/render/') || id.includes('/packages/choreo/')) return 'reel'
            return undefined
          }
        }
      }
    }
  }
})
