import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPrivatemodeWasm } from '../loadPrivatemodeWasm';

describe('loadPrivatemodeWasm', () => {
  afterEach(() => {
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  it('starts the client module and exposes its version, mismatch text and client factory', async () => {
    const wasm = await loadPrivatemodeWasm();
    expect(wasm.version).toMatch(/1\.64\.0/);
    expect(wasm.manifestMismatch.length).toBeGreaterThan(0);
    const client = wasm.createClient();
    expect(typeof client.initialize).toBe('function');
    expect(typeof client.exportSecret).toBe('function');
    client.close();
  });

  it('returns the same module on every call', async () => {
    expect(await loadPrivatemodeWasm()).toBe(await loadPrivatemodeWasm());
  });

  it('rejects every call with the same error after a failed load', async () => {
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      readFile: () => Promise.reject(new Error('wasm missing')),
    }));
    const { loadPrivatemodeWasm: freshLoad } = await import('../loadPrivatemodeWasm');
    const first = await freshLoad().catch((error: unknown) => error);
    const second = await freshLoad().catch((error: unknown) => error);
    expect(first).toBeInstanceOf(Error);
    expect(second).toBe(first);
  });
});
