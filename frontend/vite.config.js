import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Bind to all interfaces so the sandbox/preview proxy can reach the dev server
    host: true,
    // Allow the sandbox/preview host in development
    allowedHosts: true,
    // In dev the frontend runs on its own port; proxy API calls and
    // websocket traffic to the backend server (npm start in /backend).
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
