/**
 * A fake `window.electronAPI` for renderer tests. The renderer setup file installs one before
 * each test file, so every namespace and leaf exists: a leaf nobody stubbed is a `vi.fn` whose
 * promise never settles (main never answers), or for an `on…`/`subscribe…` leaf returns a no-op
 * remover.
 */
import { vi, type Mock } from 'vitest';
import type { ElectronAPI } from '../../preload';

type AnyFunction = (...args: never[]) => unknown;

export type FakeElectronAPI = {
  [N in keyof ElectronAPI]: {
    [L in keyof ElectronAPI[N]]: ElectronAPI[N][L] extends AnyFunction
      ? Mock<ElectronAPI[N][L]>
      : ElectronAPI[N][L];
  };
};

/** Implementations to put in place of the default leaves; plain functions are kept as given. */
export type ElectronAPIStubs = {
  [N in keyof ElectronAPI]?: { [L in keyof ElectronAPI[N]]?: unknown };
};

const isSubscription = (leaf: string) => /^(on|subscribe)[A-Z]/.test(leaf);

function defaultLeaf(leaf: string): Mock {
  return isSubscription(leaf) ? vi.fn(() => () => undefined) : vi.fn(() => new Promise(() => undefined));
}

function fakeNamespace(): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get(target, leaf) {
      if (typeof leaf !== 'string' || leaf === 'then') return undefined;
      if (!(leaf in target)) target[leaf] = defaultLeaf(leaf);
      return target[leaf];
    },
  });
}

/** Put a fresh fake on `window.electronAPI` and return it. */
export function installElectronAPI(): FakeElectronAPI {
  const fake = new Proxy({} as Record<string, unknown>, {
    get(target, namespace) {
      if (typeof namespace !== 'string' || namespace === 'then') return undefined;
      if (!(namespace in target)) target[namespace] = fakeNamespace();
      return target[namespace];
    },
  });
  Object.defineProperty(window, 'electronAPI', { value: fake, configurable: true, writable: true });
  return fake as unknown as FakeElectronAPI;
}

/** The fake currently on `window.electronAPI`. */
function electronAPI(): FakeElectronAPI {
  return window.electronAPI as unknown as FakeElectronAPI;
}

/** Replace leaves of the current fake with `stubs` and return the fake. */
export function stubElectronAPI(stubs: ElectronAPIStubs): FakeElectronAPI {
  const fake = electronAPI() as unknown as Record<string, Record<string, unknown>>;
  for (const [namespace, leaves] of Object.entries(stubs)) {
    Object.assign(fake[namespace], leaves);
  }
  return electronAPI();
}
