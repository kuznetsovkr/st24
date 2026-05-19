import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Keep output compatible with older Safari versions on iPhone.
    target: 'es2019'
  },
  server: {
    port: 5173
  }
});
