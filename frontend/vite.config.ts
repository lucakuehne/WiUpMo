import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 5173,
    proxy: {
      // In der Entwicklung laeuft das Frontend auf einem eigenen Port. Der
      // Umweg ueber den Proxy statt einer absoluten Backend-Adresse ist noetig,
      // weil das Sitzungscookie sonst zu einer anderen Herkunft gehoerte und
      // vom Browser nicht mitgeschickt wuerde.
      '/api': {
        target: process.env.VITE_BACKEND_URL ?? 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },

  build: {
    // Wird im Container nach /app/public kopiert und vom Backend ausgeliefert.
    outDir: 'dist',
    emptyOutDir: true,
  },
});
