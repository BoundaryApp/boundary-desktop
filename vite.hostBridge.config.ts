import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// The host-bridge utilityProcess (ADR 0027), bundled to .vite/build/hostBridge.js next to the
// main bundle. It needs only Node built-ins and Electron, so everything else is bundled in.
export default defineConfig({
  plugins: [],
  define: {
    __BOUNDARY_APP_NAME__: JSON.stringify(process.env.BOUNDARY_APP_NAME ?? ''),
    __BOUNDARY_INSTANCE__: JSON.stringify(process.env.BOUNDARY_INSTANCE ?? ''),
  },
  // Node entries, never `browser` ones: ws ships a browser stub that only throws. Forge's main
  // defaults say the same; this keeps a standalone build of this file honest too.
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    lib: {
      entry: 'src/main/services/hostBridge/bridgeProcess.ts',
      formats: ['es'],
      fileName: 'hostBridge',
    },
    rolldownOptions: {
      // ESM bundle: lets CommonJS dependencies require Node built-ins (see vite.main.config.ts).
      platform: 'node',
      external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
});
