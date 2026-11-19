import { describe, expect, it, vi } from 'vitest';
import { loadReticle } from '../loadReticle';
import { attestPrem, type ReticleLike } from '../premAttestation';

interface FakeOptions {
  workloadId?: unknown;
  hasGpu?: boolean;
  sessionId?: string | undefined;
  attest?: () => Promise<unknown>;
  build?: () => Promise<unknown>;
  /** Makes the attest result's `free()` throw. */
  resultFreeThrows?: boolean;
}

function fakeReticle(opts: FakeOptions = {}) {
  const calls = {
    url: '',
    authorization: '',
    query: [] as Array<[string, string]>,
    freed: [] as string[],
    attests: 0,
  };
  const headers = {
    get: (name: string): string | undefined =>
      name === 'x-session-id' ? ('sessionId' in opts ? opts.sessionId : 'sess-1') : undefined,
    free: (): void => void calls.freed.push('headers'),
  };
  const modules = { has_gpu: (): boolean => opts.hasGpu ?? true, free: (): void => void calls.freed.push('modules') };
  const result = {
    headers: () => headers,
    modules: () => modules,
    pod_report: (): unknown => ({
      podvm_version: '1.2.3',
      workload_id: 'workloadId' in opts ? opts.workloadId : 'qwen38-27b-h100-pcie-1-96g',
    }),
    free: (): void => {
      calls.freed.push('result');
      if (opts.resultFreeThrows) throw new Error('free failed');
    },
  };
  const client = {
    set_query: (q: { pairs: Array<[string, string]> }): void => void (calls.query = q.pairs),
    attest: (): Promise<unknown> => {
      calls.attests += 1;
      return opts.attest ? opts.attest() : Promise.resolve(result);
    },
    free: (): void => void calls.freed.push('client'),
  };
  class QueryParams {
    pairs: Array<[string, string]> = [];
    with(key: string, value: string): QueryParams {
      this.pairs.push([key, value]);
      return this;
    }
  }
  class ClientBuilder {
    constructor(url: string) {
      calls.url = url;
    }
    with_authorization(token: string): ClientBuilder {
      calls.authorization = token;
      return this;
    }
    build(): Promise<unknown> {
      return opts.build ? opts.build() : Promise.resolve(client);
    }
  }
  return { reticle: { ClientBuilder, QueryParams } as unknown as ReticleLike, calls, result, client };
}

/** Lets pending promise callbacks run; no timers involved. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const base = { apiKey: 'sk-test', model: 'qwen38-27b' };

describe('attestPrem', () => {
  it('takes the real Reticle module as a ReticleLike', async () => {
    const real: ReticleLike = await loadReticle();
    expect(typeof real.ClientBuilder).toBe('function');
  });

  it('accepts a verified pod for the requested model', async () => {
    const { reticle, calls } = fakeReticle();
    const out = await attestPrem({ ...base, reticle, signal: new AbortController().signal });
    expect(out).toEqual({ ok: true, value: { sessionId: 'sess-1', workloadId: 'qwen38-27b-h100-pcie-1-96g' } });
    expect(calls.url).toBe('https://gateway.prem.io');
    expect(calls.authorization).toBe('Bearer sk-test');
    expect(calls.query).toEqual([['model', 'qwen38-27b']]);
    expect(calls.freed.sort()).toEqual(['client', 'headers', 'modules', 'result']);
  });

  it('accepts a workload equal to the model id', async () => {
    const { reticle } = fakeReticle({ workloadId: 'qwen38-27b' });
    const out = await attestPrem({ ...base, reticle, signal: new AbortController().signal });
    expect(out.ok).toBe(true);
  });

  it('rejects a workload for another model', async () => {
    for (const workloadId of ['deepseek-v4-h100-pcie-1-96g', 'qwen38-27bx-h100', 'qwen38', '', 42, undefined]) {
      const { reticle } = fakeReticle({ workloadId });
      const out = await attestPrem({ ...base, reticle, signal: new AbortController().signal });
      expect(out).toEqual({ ok: false, detail: 'workload' });
    }
  });

  it('rejects a longer model’s workload for a shorter model id', async () => {
    const { reticle } = fakeReticle({ workloadId: 'qwen38-27b-h100-pcie-1-96g' });
    const out = await attestPrem({ ...base, model: 'qwen38', reticle, signal: new AbortController().signal });
    expect(out).toEqual({ ok: false, detail: 'workload' });
  });

  it('accepts other NVIDIA GPU suffixes', async () => {
    for (const workloadId of ['qwen38-27b-h200-sxm-8-141g', 'qwen38-27b-b200', 'qwen38-27b-l40s-pcie-1-48g']) {
      const { reticle } = fakeReticle({ workloadId });
      const out = await attestPrem({ ...base, reticle, signal: new AbortController().signal });
      expect(out.ok).toBe(true);
    }
  });

  it('rejects a pod without GPU evidence', async () => {
    const { reticle, calls } = fakeReticle({ hasGpu: false });
    const out = await attestPrem({ ...base, reticle, signal: new AbortController().signal });
    expect(out).toEqual({ ok: false, detail: 'no-gpu' });
    expect(calls.freed).toContain('result');
  });

  it('rejects when the verifier throws', async () => {
    const secret = 'https://gateway.prem.io/attestation/attest?nonce=abc failed for sk-test';
    const { reticle, calls } = fakeReticle({ attest: () => Promise.reject(new Error(secret)) });
    const out = await attestPrem({ ...base, reticle, signal: new AbortController().signal });
    expect(out).toEqual({ ok: false, detail: 'verifier' });
    expect(JSON.stringify(out)).not.toContain('sk-test');
    expect(calls.freed).toEqual(['client']);

    const failedBuild = fakeReticle({ build: () => Promise.reject(new Error(secret)) });
    expect(await attestPrem({ ...base, reticle: failedBuild.reticle, signal: new AbortController().signal })).toEqual({
      ok: false,
      detail: 'verifier',
    });
  });

  it('rejects a missing x-session-id', async () => {
    for (const sessionId of [undefined, '', '   ']) {
      const { reticle } = fakeReticle({ sessionId });
      const out = await attestPrem({ ...base, reticle, signal: new AbortController().signal });
      expect(out).toEqual({ ok: false, detail: 'no-session' });
    }
  });

  it('returns on abort without waiting for the verifier, and frees its late result', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const { reticle, calls, result } = fakeReticle({ attest: () => pending });
    const controller = new AbortController();
    const out = attestPrem({ ...base, reticle, signal: controller.signal });
    await flush();
    expect(calls.query).toHaveLength(1);
    controller.abort();
    expect(await out).toEqual({ ok: false, detail: 'verifier' });
    expect(calls.freed).toEqual([]);

    finish(result);
    await pending;
    await Promise.resolve();
    expect(calls.freed.sort()).toEqual(['client', 'result']);
  });

  it('doesn’t leave an unhandled rejection when the verifier fails after an abort', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let fail: (error: Error) => void = () => undefined;
      const pending = new Promise<unknown>((_, reject) => {
        fail = reject;
      });
      const { reticle, calls } = fakeReticle({ attest: () => pending });
      const controller = new AbortController();
      const out = attestPrem({ ...base, reticle, signal: controller.signal });
      await flush();
      expect(calls.query).toHaveLength(1);
      controller.abort();
      expect(await out).toEqual({ ok: false, detail: 'verifier' });
      fail(new Error('late'));
      await pending.catch((): undefined => undefined);
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
      expect(calls.freed).toEqual(['client']);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('sends the session id as received', async () => {
    const { reticle } = fakeReticle({ sessionId: ' sess-2 ' });
    const out = await attestPrem({ ...base, reticle, signal: new AbortController().signal });
    expect(out).toEqual({ ok: true, value: { sessionId: ' sess-2 ', workloadId: 'qwen38-27b-h100-pcie-1-96g' } });
  });

  it('doesn’t attest when the signal aborts while the client is being built', async () => {
    let finishBuild: (value: unknown) => void = () => undefined;
    const building = new Promise<unknown>((resolve) => {
      finishBuild = resolve;
    });
    const { reticle, calls, client } = fakeReticle({ build: () => building });
    const controller = new AbortController();
    const out = attestPrem({ ...base, reticle, signal: controller.signal });
    controller.abort();
    expect(await out).toEqual({ ok: false, detail: 'verifier' });

    finishBuild(client);
    await flush();
    expect(calls.attests).toBe(0);
    expect(calls.query).toEqual([]);
    expect(calls.freed).toEqual(['client']);
  });

  it('frees the client and leaves no unhandled rejection when a late result’s free throws', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let finish: (value: unknown) => void = () => undefined;
      const pending = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      const { reticle, calls, result } = fakeReticle({ attest: () => pending, resultFreeThrows: true });
      const controller = new AbortController();
      const out = attestPrem({ ...base, reticle, signal: controller.signal });
      await flush();
      controller.abort();
      expect(await out).toEqual({ ok: false, detail: 'verifier' });
      finish(result);
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
      expect(calls.freed).toEqual(['result', 'client']);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('still returns its verdict when freeing the result throws', async () => {
    const { reticle, calls } = fakeReticle({ resultFreeThrows: true });
    const out = await attestPrem({ ...base, reticle, signal: new AbortController().signal });
    expect(out.ok).toBe(true);
    expect(calls.freed).toContain('client');
  });

  it('doesn’t start when the signal has already aborted', async () => {
    const { reticle, calls } = fakeReticle();
    const controller = new AbortController();
    controller.abort();
    expect(await attestPrem({ ...base, reticle, signal: controller.signal })).toEqual({ ok: false, detail: 'verifier' });
    expect(calls.url).toBe('');
  });
});
