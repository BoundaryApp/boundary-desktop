import {
  ALL_STACK_CAPABILITIES,
  STACK_CAPABILITY_MISSING_TEXT,
  type StackCapability,
  type StackHostCapabilities,
} from '../../../shared/stackCapabilities';
import { StackCapabilityMissing } from './capabilityMissing';
import { createFakeStackFiles, type FakeStackFiles } from './fakeStackFiles';
import type { StackCommands, StackEndpoints, StackHost } from './types';

/** One call a test's stack commands received. */
export interface FakeStackCommandCall {
  method: keyof StackCommands;
  args: string[];
}

/** A stack host for tests: files in memory, commands that record their calls and succeed. */
export interface FakeStackHost extends StackHost {
  files: FakeStackFiles;
  /** Every command call, in order. */
  calls: FakeStackCommandCall[];
}

export interface FakeStackHostOptions {
  /** Capabilities to change from the local host's, such as `{ hostFolders: false }`. */
  capabilities?: Partial<StackHostCapabilities>;
  /** Initial files, keyed `<location>:<relative path>` as in `createFakeStackFiles`. */
  files?: Record<string, string>;
  /** The port on this machine each stored port reaches; unset ports are 0. */
  ports?: Partial<Record<Parameters<StackEndpoints['port']>[0], number>>;
}

export function createFakeStackHost(options: FakeStackHostOptions = {}): FakeStackHost {
  const calls: FakeStackCommandCall[] = [];
  const record = (method: keyof StackCommands, args: string[]) => calls.push({ method, args });
  const done = { stdout: '', stderr: '' };
  const commands: StackCommands = {
    compose: async (args) => (record('compose', args), done),
    composeStreaming: async (args) => (record('composeStreaming', args), { ...done, code: 0, cancelled: false }),
    scriptEnv: async () => ({}),
    scriptCompose: async (args) => (record('scriptCompose', args), done),
    scriptCli: async (args) => (record('scriptCli', args), done),
    runScript: async (script, args) => (record('runScript', [script, ...args]), 0),
  };
  const portUrl: StackEndpoints['portUrl'] = (stackPort, urlPath = '', hostname = '127.0.0.1') =>
    `http://${hostname}:${stackPort}${urlPath}`;
  const port: StackEndpoints['port'] = (key) => options.ports?.[key] ?? 0;
  return {
    kind: 'fake',
    commands,
    files: createFakeStackFiles(options.files),
    endpoints: { port, url: (key, urlPath) => portUrl(port(key), urlPath), portUrl },
    capabilities: { ...ALL_STACK_CAPABILITIES, ...options.capabilities },
    localPaths: { stack: '/fake-stack', data: '/fake-stack/data' },
    calls,
  };
}

/**
 * A stand-in for `stackHost/capabilities` that reads `get()` on each call:
 * `vi.mock('…/stackHost/capabilities', async () => (await import('…/fakeStackHost')).fakeCapabilitiesModule(() => host.capabilities))`.
 */
export function fakeCapabilitiesModule(get: () => StackHostCapabilities): typeof import('./capabilities') {
  const has = (capability: StackCapability) => get()[capability];
  return {
    StackCapabilityMissing,
    getStackCapabilities: () => ({ ...get() }),
    hasStackCapability: has,
    requireStackCapability: (capability) => {
      if (!has(capability)) throw new StackCapabilityMissing(capability);
    },
    stackCapabilityRefusal: (capability) => (has(capability) ? null : STACK_CAPABILITY_MISSING_TEXT[capability]),
  };
}
