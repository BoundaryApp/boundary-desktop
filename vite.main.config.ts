import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [],
  define: {
    __BOUNDARY_UPDATE_FEED_URL__: JSON.stringify(process.env.BOUNDARY_UPDATE_FEED_URL ?? ''),
    __BOUNDARY_UPDATE_KEY_REQUIRED__: JSON.stringify(process.env.BOUNDARY_UPDATE_KEY_REQUIRED === '1'),
    __BOUNDARY_APP_NAME__: JSON.stringify(process.env.BOUNDARY_APP_NAME ?? ''),
    __BOUNDARY_PODMAN_MACHINE__: JSON.stringify(process.env.BOUNDARY_PODMAN_MACHINE ?? ''),
  },
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