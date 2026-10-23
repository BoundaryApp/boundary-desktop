import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [],
  build: {
    lib: {
      entry: 'src/main/index.ts',
      formats: ['es'],
      fileName: 'index'
    },
    commonjsOptions: {
      dynamicRequireTargets: ['better-sqlite3'],
    },
    rollupOptions: {
      external: [
        'better-sqlite3',
        'electron',
        'dockerode',
        'ssh2',
        'playwright',
        'fs',
        'path',
        'crypto',
        'stream',
        'util',
        'events',
        'child_process',
        'net',
        'tls',
        'http',
        'https',
        'url',
        'querystring',
        'zlib',
        'buffer',
        'os',
        'assert',
        'constants',
        'domain',
        'punycode',
        'string_decoder',
        'timers',
        'tty',
        'vm',
        'worker_threads'
      ],
    },
  },
  optimizeDeps: {
    exclude: ['dockerode', 'ssh2', 'playwright']
  }
});