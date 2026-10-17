import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Managed production builds inject an explicit allowlist and must not merge
  // ignored client/.env files into the public bundle.
  ...(process.env.CLIENT_CONFIG_MANAGED_BUILD === '1' ? { envDir: false } : {}),
  plugins: [react()],
  build: {
    // Keep output compatible with older Safari versions on iPhone.
    target: 'es2019'
  },
  server: {
    port: 5173
  }
});
