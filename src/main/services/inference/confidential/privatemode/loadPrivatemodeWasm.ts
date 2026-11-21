import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PrivatemodeWasm, PrivatemodeWasmClient } from './privatemodeAttestation';

/** The part of `privatemode-ai/dist/wasm.js` the loader calls. */
interface WasmModule {
  initWasm(source: Uint8Array): Promise<void>;
  createWasmClient(): PrivatemodeWasmClient;
  privatemodeVersion(): string;
  errManifestMismatch(): string;
}

const PACKAGE = 'privatemode-ai';

/**
 * The installed package's folder. Its `exports` map offers only the OpenAI wrapper, so the folder
 * is found on the module search path rather than through `exports`.
 */
function packageDir(): string {
  const paths = createRequire(import.meta.url).resolve.paths(PACKAGE) ?? [];
  for (const base of paths) {
    const dir = join(base, PACKAGE);
    if (existsSync(join(dir, 'dist', 'wasm.js'))) return dir;
  }
  throw new Error('privatemode-ai isn’t installed');
}

/**
 * Importing `wasm.js` runs Go's `wasm_exec.js`, which installs stub `globalThis.fs` and
 * `globalThis.path` when they are missing, in the main process for the rest of its life. The `fs`
 * stub sends writes to `console.log` and fails everything else with ENOSYS; the `path` stub's only
 * method, `resolve`, joins its arguments with `/`. Nothing in Boundary reads either global; code
 * that needs the modules imports `node:fs` and `node:path`.
 */
async function open(): Promise<PrivatemodeWasm> {
  const dir = packageDir();
  const wasm = (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'dist', 'wasm.js')).href)) as WasmModule;
  await wasm.initWasm(await readFile(join(dir, 'dist', 'privatemode.wasm')));
  return {
    version: wasm.privatemodeVersion(),
    manifestMismatch: wasm.errManifestMismatch(),
    createClient: () => wasm.createWasmClient(),
  };
}

let loading: Promise<PrivatemodeWasm> | null = null;

/**
 * Privatemode's client (Go compiled to WebAssembly), which attests the deployment and exchanges
 * the chat secret. `wasm.js` and `privatemode.wasm` are read from the package's own folder, so the
 * package stays external to the bundle and is copied into the packaged app (vite.main.config.ts,
 * forge.config.ts). The Go runtime starts once per process: the first result is cached, and a
 * failed load stays failed until the app restarts.
 */
export function loadPrivatemodeWasm(): Promise<PrivatemodeWasm> {
  loading ??= open();
  return loading;
}
