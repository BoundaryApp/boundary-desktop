import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    __dirname: 'undefined',
    __filename: 'undefined',
    global: 'globalThis'
  },
  build: {
    rolldownOptions: {
      external: ['electron']
    }
  },
  optimizeDeps: {
    exclude: ['electron']
  }
});
