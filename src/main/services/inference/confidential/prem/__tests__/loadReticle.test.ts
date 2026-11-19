import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadReticle } from '../loadReticle';

describe('loadReticle', () => {
  afterEach(() => {
    vi.doUnmock('@premai/reticle');
    vi.resetModules();
  });

  it('loads the verifier and exposes ClientBuilder', async () => {
    const reticle = await loadReticle();
    expect(typeof reticle.ClientBuilder).toBe('function');
  });

  it('returns the same module on every call', async () => {
    expect(await loadReticle()).toBe(await loadReticle());
  });

  it('rejects every call with the same error after a failed load', async () => {
    vi.resetModules();
    vi.doMock('@premai/reticle', () => {
      throw new Error('wasm missing');
    });
    const { loadReticle: freshLoad } = await import('../loadReticle');
    const first = await freshLoad().catch((error: unknown) => error);
    const second = await freshLoad().catch((error: unknown) => error);
    expect(first).toBeInstanceOf(Error);
    expect(second).toBe(first);
  });
});
