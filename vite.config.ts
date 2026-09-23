import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS=1 serves a self-signed cert so phones on the LAN get a secure context (Safari only exposes WebGPU there).
const https = process.env.HTTPS === '1';

export default defineConfig({
  // Relative asset paths so the same build works from the Capacitor bundle and any static host.
  base: './',
  plugins: https ? [basicSsl()] : [],
  server: { port: 5280, strictPort: true },
  build: { target: 'es2022' },
});
