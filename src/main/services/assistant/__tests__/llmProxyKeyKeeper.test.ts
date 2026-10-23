import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetLlmProxyKeeperForTests,
  checkLlmProxyUpstream,
  keepLlmProxyUpstream,
  noteLlmProxyPushed,
  proxyNeedsPush,
} from '../llmProxyKeyKeeper';

const upstream = { url: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-secret' };

function routes(url: string, apiKeySet: boolean) {
  return {
    chat: { url, apiKeySet },
    lightrag: { url, apiKeySet },
    embed: { url: 'http://host.docker.internal:1234/v1', apiKeySet: false },
  };
}

/** A fake proxy: GET returns `view`, POST records the body and returns the new view. */
function fakeProxy(view: { url: string; api_key_set: boolean }, postStatus = 200) {
  const pushes: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      pushes.push(JSON.parse(String(init.body)));
      return new Response(postStatus === 200 ? JSON.stringify({}) : 'no', { status: postStatus });
    }
    return new Response(JSON.stringify({ chat: view, lightrag: view, embed: view }), {
      status: 200,
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, pushes };
}

/**
 * A proxy that reports boot_id and pushed (stack releases after v0.2.0). `restart()`
 * gives it a new boot_id and forgets every push, as a new process would.
 */
function bootingProxy() {
  let boot = 1;
  let pushed = false;
  const pushes: unknown[] = [];
  const view = () => {
    const route = { url: upstream.url, api_key_set: pushed, pushed };
    return JSON.stringify({
      chat: route,
      lightrag: route,
      embed: { url: '', api_key_set: false, pushed: false },
      proxy: { boot_id: `boot-${boot}`, started_at: 1_791_331_200 + boot },
    });
  };
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      pushes.push(JSON.parse(String(init.body)));
      pushed = true;
    }
    return new Response(view(), { status: 200 });
  });
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    pushes,
    restart() {
      boot += 1;
      pushed = false;
    },
  };
}

afterEach(() => {
  __resetLlmProxyKeeperForTests();
  vi.useRealTimers();
});

describe('llmProxyKeyKeeper', () => {
  it('needs a push when a route lost its key or points elsewhere', () => {
    expect(proxyNeedsPush(routes(upstream.url, true), upstream)).toBe(false);
    expect(proxyNeedsPush(routes(upstream.url, false), upstream)).toBe(true);
    expect(proxyNeedsPush(routes('http://host.docker.internal:1234/v1', true), upstream)).toBe(
      true
    );
    // A keyless local endpoint never reports a key; that is not a reason to push.
    expect(proxyNeedsPush(routes(upstream.url, false), { ...upstream, apiKey: '' })).toBe(false);
  });

  it('pushes the key again after the proxy restarted without it', async () => {
    const proxy = fakeProxy({ url: upstream.url, api_key_set: false });
    keepLlmProxyUpstream(
      () => ({ adminPort: 4001, token: 't', fetchImpl: proxy.fetchImpl }),
      upstream
    );
    expect(await checkLlmProxyUpstream()).toBe('repushed');
    expect(proxy.pushes).toEqual([
      {
        chat: { url: upstream.url, api_key: 'sk-or-secret' },
        lightrag: { url: upstream.url, api_key: 'sk-or-secret' },
      },
    ]);
  });

  it('leaves a healthy proxy alone', async () => {
    const proxy = fakeProxy({ url: upstream.url, api_key_set: true });
    keepLlmProxyUpstream(
      () => ({ adminPort: 4001, token: 't', fetchImpl: proxy.fetchImpl }),
      upstream
    );
    expect(await checkLlmProxyUpstream()).toBe('ok');
    expect(proxy.pushes).toEqual([]);
  });

  it('reports an unreachable proxy and a failed push', async () => {
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    keepLlmProxyUpstream(() => ({ adminPort: 4001, token: 't', fetchImpl: down }), upstream);
    expect(await checkLlmProxyUpstream()).toBe('unreachable');

    const refusing = fakeProxy({ url: upstream.url, api_key_set: false }, 401);
    keepLlmProxyUpstream(
      () => ({ adminPort: 4001, token: 't', fetchImpl: refusing.fetchImpl }),
      upstream
    );
    expect(await checkLlmProxyUpstream()).toBe('failed');
  });

  it('does nothing before anything is kept, or without a token', async () => {
    expect(await checkLlmProxyUpstream()).toBe('idle');
    keepLlmProxyUpstream(() => null, upstream);
    expect(await checkLlmProxyUpstream()).toBe('idle');
  });

  it('checks on an interval', async () => {
    vi.useFakeTimers();
    const proxy = fakeProxy({ url: upstream.url, api_key_set: false });
    keepLlmProxyUpstream(
      () => ({ adminPort: 4001, token: 't', fetchImpl: proxy.fetchImpl }),
      upstream,
      1_000
    );
    expect(proxy.pushes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(proxy.pushes).toHaveLength(1);
  });
  it('uses boot_id and pushed when the proxy reports them', () => {
    const status = (bootId: string, pushed: boolean) => ({
      chat: { url: 'anything', apiKeySet: false, pushed },
      lightrag: { url: 'anything', apiKeySet: false, pushed },
      embed: { url: '', apiKeySet: false, pushed: false },
      proxy: { bootId, startedAt: 0 },
    });
    // Same process, both routes pushed: fine even though no key or URL matches.
    expect(proxyNeedsPush(status('a', true), upstream, 'a')).toBe(false);
    // Restarted.
    expect(proxyNeedsPush(status('b', true), upstream, 'a')).toBe(true);
    expect(proxyNeedsPush(status('a', false), upstream, 'a')).toBe(true);
    // None of our pushes has landed yet; whatever is there may be someone else's.
    expect(proxyNeedsPush(status('a', true), upstream, undefined)).toBe(true);
  });

  it('pushes again after a restart, and only then', async () => {
    const proxy = bootingProxy();
    keepLlmProxyUpstream(() => ({ adminPort: 4001, token: 't', fetchImpl: proxy.fetchImpl }), {
      url: upstream.url,
      apiKey: '',
    });
    // A keyless upstream: the first check pushes, later ones leave it alone.
    expect(await checkLlmProxyUpstream()).toBe('repushed');
    expect(await checkLlmProxyUpstream()).toBe('ok');
    expect(await checkLlmProxyUpstream()).toBe('ok');
    proxy.restart();
    expect(await checkLlmProxyUpstream()).toBe('repushed');
    expect(await checkLlmProxyUpstream()).toBe('ok');
    expect(proxy.pushes).toHaveLength(2);
  });

  it('takes the boot_id from the push made during a model change', async () => {
    const proxy = bootingProxy();
    keepLlmProxyUpstream(
      () => ({ adminPort: 4001, token: 't', fetchImpl: proxy.fetchImpl }),
      upstream
    );
    await proxy.fetchImpl('x', { method: 'POST', body: '{}' });
    noteLlmProxyPushed({
      chat: { url: upstream.url, apiKeySet: true, pushed: true },
      lightrag: { url: upstream.url, apiKeySet: true, pushed: true },
      embed: { url: '', apiKeySet: false, pushed: false },
      proxy: { bootId: 'boot-1', startedAt: 0 },
    });
    expect(await checkLlmProxyUpstream()).toBe('ok');
    expect(proxy.pushes).toHaveLength(1);
  });
});
