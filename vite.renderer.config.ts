import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'boundary-app-name',
      transformIndexHtml: (html) =>
        html.replace('<title>Boundary</title>', `<title>${process.env.BOUNDARY_APP_NAME || 'Boundary'}</title>`),
    },
  ],
  define: {
    __BOUNDARY_APP_NAME__: JSON.stringify(process.env.BOUNDARY_APP_NAME ?? ''),
    __BOUNDARY_INSTANCE__: JSON.stringify(process.env.BOUNDARY_INSTANCE ?? ''),
    __dirname: 'undefined',
    __filename: 'undefined',
    global: 'globalThis'
  },
  resolve: {
    alias: {
      // The release notes a build bundles, or an empty folder (ADR 0059).
      '@release-notes': resolve(process.env.BOUNDARY_RELEASE_NOTES_DIR || 'src/release-notes-empty'),
    },
  },
  build: {
    rolldownOptions: {
      external: ['electron']
    }
  },
  optimizeDeps: {
    exclude: ['electron']
  },
  ssr: {
    external: ['electron']
  }
});
