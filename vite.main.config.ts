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
    rolldownOptions: {
      // The bundle is ESM, so CommonJS dependencies (electron-squirrel-startup, debug) have no
      // `require` for Node built-ins; on the node platform Rolldown makes one with createRequire.
      platform: 'node',
      external: [
        'better-sqlite3',
        'electron',
        'dockerode',
        'ssh2',
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
    exclude: ['dockerode', 'ssh2']
  }
});