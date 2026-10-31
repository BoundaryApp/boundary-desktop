import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    __BOUNDARY_APP_NAME__: JSON.stringify(process.env.BOUNDARY_APP_NAME ?? ''),
    __BOUNDARY_INSTANCE__: JSON.stringify(process.env.BOUNDARY_INSTANCE ?? ''),
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
