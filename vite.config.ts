import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// El frontend vive en src/web; en desarrollo /api se redirige al servidor (puerto 8787).
export default defineConfig({
  root: 'src/web',
  publicDir: '../../public',
  plugins: [react()],
  build: { outDir: '../../dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
