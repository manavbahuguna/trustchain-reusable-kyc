import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env': {},
  },
  server: {
    port: 5173,
    https: false, // WebAuthn requires HTTPS in production; use a secure tunnel or localhost
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      external: [], // ethers is imported lazily in blockchain.js
    },
  },
});
