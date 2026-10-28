import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  server: { host: '127.0.0.1' },
  build: { rollupOptions: { input: [fileURLToPath(new URL('./index.html', import.meta.url)), fileURLToPath(new URL('./capture.html', import.meta.url)), fileURLToPath(new URL('./node.html', import.meta.url))] } },
});
