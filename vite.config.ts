import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the same build works from the Capacitor bundle and any static host.
  base: './',
  server: { port: 5280, strictPort: true },
  build: { target: 'es2022' },
});
