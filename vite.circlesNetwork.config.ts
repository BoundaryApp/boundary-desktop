import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// The Circles network utilityProcess (ADR 0032 §1), bundled to .vite/build/circlesNetwork.js
// next to the main bundle. The Holepunch modules stay external: require-addon finds each native
// addon's prebuild beside its package, so forge.config.ts copies their package trees into the app.
export default defineConfig({
  plugins: [],
  define: {
    __BOUNDARY_APP_NAME__: JSON.stringify(process.env.BOUNDARY_APP_NAME ?? ''),
    __BOUNDARY_INSTANCE__: JSON.stringify(process.env.BOUNDARY_INSTANCE ?? ''),
  },
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    lib: {
      entry: 'src/main/services/circles/networkProcess.ts',
      formats: ['es'],
      fileName: 'circlesNetwork',
    },
    rolldownOptions: {
      // ESM bundle: lets CommonJS dependencies require Node built-ins (see vite.main.config.ts).
      platform: 'node',
      external: [
        'electron',
        'autobase',
        'blind-pairing',
        'compact-encoding',
        'corestore',
        'hyperbee',
        'hypercore-crypto',
        'hyperswarm',
        'protomux',
        'z32',
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
      ],
    },
  },
});
