import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      // SVG and PNG assets are already matched by Workbox's glob below. Keep
      // only the ICO here so each asset has a single precache entry.
      includeAssets: ['icons/icon-dark.ico'],
      manifest: false,
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: 'index.html',
        globPatterns: ['**/*.{html,js,css,svg,png,webmanifest}'],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        // Preserve localhost:5173 so stream URLs come back through Vite, and
        // tell the Rust server that this development hop is plain HTTP.
        changeOrigin: false,
        headers: { 'x-forwarded-proto': 'http' },
      },
    },
  },
  build: {
    target: 'safari15',
    minify: 'esbuild',
    cssMinify: true,
    sourcemap: false,
  },
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**', 'src/vite-env.d.ts'],
    },
  },
});
