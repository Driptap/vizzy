import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // relative base so the built index.html works from the tauri:// asset scheme
  base: './',
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
});
