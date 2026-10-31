import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CirclesSnapshot } from '../../../../shared/types/circles';

const SNAPSHOT: CirclesSnapshot = { identity: 'ab'.repeat(32), circles: [] };

/** A fake network process: answers `circles-start` with ready, and requests with `reply`. */
class FakeChild extends EventEmitter {
  pid = 42;
  reply: (request: { op: string }) => Record<string, unknown> = () => ({ ok: true });
  postMessage = vi.fn((message: { type: string; id?: number; request?: { op: string } }) => {
    if (message.type === 'circles-start') setImmediate(() => this.emit('message', { type: 'circles-ready', snapshot: SNAPSHOT }));
    if (message.type === 'circles-request') {
      const answer = this.reply(message.request!);
      setImmediate(() => this.emit('message', { type: 'circles-reply', id: message.id, ...answer }));
    }
    if (message.type === 'stop') setImmediate(() => this.emit('exit', 0));
  });
  kill = vi.fn(() => this.emit('exit', null));
}

let lastChild: FakeChild | null = null;
const fork = vi.fn(() => (lastChild = new FakeChild()));
const broadcasts: unknown[] = [];

const blocker = vi.hoisted(() => ({ next: 1, running: new Set<number>() }));
const powerSaveBlocker = {
  start: vi.fn(() => {
    const id = blocker.next++;
    blocker.running.add(id);
    return id;
  }),
  stop: vi.fn((id: number) => void blocker.running.delete(id)),
  isStarted: (id: number) => blocker.running.has(id),
};
vi.mock('electron', () => ({ app: { getPath: () => '/user-data' }, utilityProcess: { fork }, powerSaveBlocker }));
vi.mock('../../onboarding/OpenAiOnboardingStore', () => ({
  getSlotLlmConnection: async (slot: string) =>
    slot === 'local' ? { endpointUrl: 'http://127.0.0.1:1234/v1', modelId: 'qwen3-8b' } : null,
}));
vi.mock('../../windows', () => ({ broadcast: (_channel: string, payload: unknown) => broadcasts.push(payload) }));
vi.mock('../../../persistDebugLog', () => ({ persistDebugLog: () => undefined }));
vi.mock('../circlesDiagnostics', () => ({ diag: () => undefined, short: (key: string | null) => key?.slice(0, 8) ?? null }));

const NOT_SHARING = { models: [], circles: [], paused: false, away: false };
const stored = {
  name: '',
  circles: new Map<string, unknown>(),
  providers: {} as Record<string, unknown>,
  sharing: NOT_SHARING as unknown,
};
vi.mock('../circlesStore', () => ({
  getCirclesDisplayName: () => stored.name,
  setCirclesDisplayName: (name: string) => void (stored.name = name),
  hasCircles: () => stored.circles.size > 0,
  loadCircleSeeds: async () => ({ identitySeed: '11'.repeat(32), deviceSeed: '22'.repeat(32) }),
  listCircleSecrets: async () => [...stored.circles.values()],
  saveCircleSecrets: async (secrets: { key: string }) => void stored.circles.set(secrets.key, secrets),
  forgetCircle: (key: string) => void stored.circles.delete(key),
  getProviderSettings: () => stored.providers,
  getCircleSharing: () => stored.sharing,
  setCircleSharing: (sharing: unknown) => void (stored.sharing = sharing),
  setProviderSettings: (identity: string, settings: { private: boolean; trusted: boolean }) => {
    stored.providers = { ...stored.providers, [identity]: settings };
  },
}));

async function load() {
  vi.resetModules();
  return import('../circlesService');
}

beforeEach(() => {
  fork.mockClear();
  lastChild = null;
  broadcasts.length = 0;
  stored.name = '';
  stored.circles.clear();
  stored.providers = {};
  stored.sharing = NOT_SHARING;
  blocker.running.clear();
  powerSaveBlocker.start.mockClear();
  powerSaveBlocker.stop.mockClear();
});

/** Lets the fake process's answers (sent on the next tick) and the start's sharing sync run. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('circlesService', () => {
  it('asks for a display name before starting anything', async () => {
    const service = await load();
    await expect(service.ensureCirclesStarted()).rejects.toThrow(/name/);
    expect(fork).not.toHaveBeenCalled();
  });

  it('starts the process with the seeds and stored Circles, and stores a created Circle', async () => {
    const service = await load();
    expect((await service.setDisplayName('  Ada ')).success).toBe(true);
    stored.circles.set('c1', { namespace: 'n1', key: 'c1', encryptionKey: 'e1' });
    lastChild = null;

    const secrets = { namespace: 'n2', key: 'c2', encryptionKey: 'e2', name: 'Garden club' };
    fork.mockImplementationOnce(() => {
      lastChild = new FakeChild();
      lastChild.reply = () => ({ ok: true, secrets });
      return lastChild;
    });
    const created = await service.createCircle('Garden club');
    expect(created).toMatchObject({ success: true, key: 'c2' });
    expect(lastChild!.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'circles-start',
        name: 'Ada',
        identitySeed: '11'.repeat(32),
        circles: [{ namespace: 'n1', key: 'c1', encryptionKey: 'e1' }],
      })
    );
    expect(stored.circles.get('c2')).toEqual(secrets);
    expect(service.getCirclesState()).toMatchObject({ status: 'running', snapshot: SNAPSHOT });
  });

  it('passes a refusal through with the state, and stores nothing', async () => {
    stored.name = 'Bo';
    const service = await load();
    fork.mockImplementationOnce(() => {
      lastChild = new FakeChild();
      lastChild.reply = () => ({ ok: false, error: 'That invite has expired. Ask for a new one.' });
      return lastChild;
    });
    const joined = await service.joinCircle('code');
    expect(joined).toMatchObject({ success: false, error: /expired/, state: { status: 'running' } });
    expect(stored.circles.size).toBe(0);
  });

  it('answers pending requests when the process dies, and reports it', async () => {
    stored.name = 'Bo';
    const service = await load();
    fork.mockImplementationOnce(() => {
      const child = new FakeChild();
      lastChild = child;
      // Never answers the join; dies instead. `child`, not `lastChild`: a later test's child
      // must not get this exit.
      child.reply = () => {
        setImmediate(() => child.emit('exit', 1));
        return { ok: true, never: true };
      };
      const post = lastChild.postMessage.getMockImplementation()!;
      lastChild.postMessage.mockImplementation((message) => {
        if (message.type === 'circles-request') return void lastChild!.reply(message.request!);
        return post(message);
      });
      return lastChild;
    });
    const joined = await service.joinCircle('code');
    expect(joined).toMatchObject({ success: false, error: 'Circles stopped.' });
    expect(service.getCirclesState()).toMatchObject({ status: 'failed' });
  });

  it('forgets a Circle it has left, and starts at launch only for a member', async () => {
    stored.name = 'Ada';
    let service = await load();
    service.startCirclesIfMember();
    expect(fork).not.toHaveBeenCalled();

    stored.circles.set('c1', { namespace: 'n1', key: 'c1' });
    service = await load();
    service.startCirclesIfMember();
    // The leave waits on the launch's start rather than forking a second process.
    expect(await service.leaveCircle('c1')).toMatchObject({ success: true });
    expect(fork).toHaveBeenCalledTimes(1);
    expect(stored.circles.has('c1')).toBe(false);
    await service.stopCircles();
    expect(lastChild!.postMessage).toHaveBeenLastCalledWith({ type: 'stop' });
  });

  it('forgets a Circle the network process says this device was removed from', async () => {
    stored.name = 'Bo';
    stored.circles.set('c1', { namespace: 'n1', key: 'c1' });
    const service = await load();
    await service.ensureCirclesStarted();
    lastChild!.emit('message', { type: 'circle-removed', key: 'c1' });
    expect(stored.circles.has('c1')).toBe(false);
    await service.stopCircles();
  });

  describe('shared models', () => {
    const PEER = { circleId: 'c1', providerId: 'a'.repeat(64) };

    async function running() {
      stored.name = 'Bo';
      const service = await load();
      await service.ensureCirclesStarted();
      const child = lastChild!;
      const sent = () =>
        child.postMessage.mock.calls.map(([message]) => message as { type: string; id?: number; [key: string]: unknown });
      const lastRequest = () => sent().filter((message) => message.type === 'shared-request').at(-1)!;
      const reply = (message: Record<string, unknown>) => child.emit('message', message);
      return { service, child, sent, lastRequest, reply };
    }

    it('refuses while Circles aren’t running', async () => {
      const service = await load();
      await expect(service.fetchSharedModel(PEER, { method: 'POST', path: '/v1/chat/completions' })).rejects.toThrow(/running/);
    });

    it('streams a provider’s reply as a Response', async () => {
      const { service, lastRequest, reply } = await running();
      const pending = service.fetchSharedModel(PEER, { method: 'POST', path: '/v1/chat/completions', body: '{"model":"m"}' });
      const request = lastRequest();
      expect(request).toMatchObject({ key: 'c1', provider: PEER.providerId, request: { method: 'POST', body: '{"model":"m"}' } });
      reply({ type: 'shared-head', id: request.id, status: 200, contentType: 'text/event-stream' });
      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      reply({ type: 'shared-chunk', id: request.id, data: new TextEncoder().encode('data: 1\n\n') });
      reply({ type: 'shared-chunk', id: request.id, data: new TextEncoder().encode('data: [DONE]\n\n') });
      reply({ type: 'shared-end', id: request.id });
      expect(await response.text()).toBe('data: 1\n\ndata: [DONE]\n\n');
    });

    it('rejects when the provider was never reached, and errors a reply that breaks', async () => {
      const { service, lastRequest, reply } = await running();
      const unreached = service.fetchSharedModel(PEER, { method: 'POST', path: '/v1/chat/completions' });
      reply({ type: 'shared-end', id: lastRequest().id, error: 'The provider is not connected.' });
      await expect(unreached).rejects.toThrow('The provider is not connected.');

      const broken = service.fetchSharedModel(PEER, { method: 'POST', path: '/v1/chat/completions' });
      const id = lastRequest().id;
      reply({ type: 'shared-head', id, status: 200, contentType: 'text/event-stream' });
      const response = await broken;
      reply({ type: 'shared-end', id, error: 'The provider disconnected.' });
      await expect(response.text()).rejects.toThrow('The provider disconnected.');
    });

    it('cancels in the network process when aborted or when the reader stops', async () => {
      const { service, sent, lastRequest, reply } = await running();
      const abort = new AbortController();
      const before = service.fetchSharedModel(PEER, { method: 'POST', path: '/v1/chat/completions' }, abort.signal);
      const first = lastRequest().id;
      abort.abort();
      await expect(before).rejects.toThrow('cancelled');

      const after = service.fetchSharedModel(PEER, { method: 'POST', path: '/v1/chat/completions' });
      const second = lastRequest().id;
      reply({ type: 'shared-head', id: second, status: 200, contentType: 'text/event-stream' });
      await (await after).body!.cancel();
      expect(sent().filter((message) => message.type === 'shared-cancel').map((message) => message.id)).toEqual([first, second]);
    });

    it('fails calls in flight when the process exits', async () => {
      const { service, child } = await running();
      const pending = service.fetchSharedModel(PEER, { method: 'POST', path: '/v1/chat/completions' });
      child.emit('exit', 1);
      await expect(pending).rejects.toThrow('Circles stopped.');
    });

    it('describes offers for the chain resolver; a paused offer counts as withdrawn', async () => {
      const { service, reply } = await running();
      const offer = { identity: PEER.providerId, name: 'Ada', isMine: false, away: false, online: true };
      reply({
        type: 'circles-snapshot',
        snapshot: {
          ...SNAPSHOT,
          circles: [
            {
              key: 'c1',
              name: 'Workshop',
              myRole: 'member',
              members: [],
              invites: [],
              offers: [
                { ...offer, available: true, models: [{ id: 'qwen3-8b', contextLength: 32768, tools: true }, { id: 'tiny', tools: false }] },
                { ...offer, identity: 'b'.repeat(64), available: false, models: [{ id: 'm', tools: false }] },
              ],
            },
          ],
        },
      });
      const facts = service.sharedModelFacts();
      expect(facts.circleJoined('c1')).toBe(true);
      expect(facts.circleJoined('c2')).toBe(false);
      expect(facts.peerOffer(PEER)).toEqual({ 'qwen3-8b': { contextLength: 32768 }, tiny: {} });
      expect(facts.peerOffer({ circleId: 'c1', providerId: 'b'.repeat(64) })).toBeNull();
      expect([facts.providerTrusted(PEER.providerId), facts.providerPrivate(PEER.providerId)]).toEqual([false, false]);
    });

    it('stores what the user accepts from a provider and answers the resolver with it', async () => {
      const { service } = await running();
      const result = service.setProviderSettings(PEER.providerId, { private: false, trusted: true });
      expect(result).toMatchObject({ success: true, state: { providers: { [PEER.providerId]: { private: false, trusted: true } } } });
      const facts = service.sharedModelFacts();
      expect([facts.providerTrusted(PEER.providerId), facts.providerPrivate(PEER.providerId)]).toEqual([true, false]);
      expect(service.setProviderSettings('not-a-key', { private: true, trusted: true }).success).toBe(false);
      expect(service.setProviderSettings(SNAPSHOT.identity, { private: true, trusted: true }).success).toBe(false);
    });
  });

  describe('peer signals', () => {
    const CIRCLE = 'cd'.repeat(32);
    const FROM = 'ef'.repeat(32);
    const received = (topic: string, payload: unknown) =>
      lastChild!.emit('message', { type: 'signal-received', signal: { circle: CIRCLE, from: FROM, topic, payload } });
    const topicsPosted = () =>
      lastChild!.postMessage.mock.calls.map(([message]) => message).filter((message) => message.type === 'signal-topics');

    async function running() {
      const service = await load();
      stored.name = 'Ada';
      await service.setDisplayName('Ada');
      await service.ensureCirclesStarted();
      await flush();
      return service;
    }

    it('tells the process which topics it listens to, from start and as they change', async () => {
      const service = await load();
      stored.name = 'Ada';
      await service.setDisplayName('Ada');
      const stop = service.onCircleSignal('typing', () => undefined);
      await service.ensureCirclesStarted();
      await flush();
      expect(topicsPosted()).toEqual([{ type: 'signal-topics', topics: ['typing'] }]);
      stop();
      expect(topicsPosted().at(-1)).toEqual({ type: 'signal-topics', topics: [] });
    });

    it('hands a signal to its topic’s listeners, and one listener throwing doesn’t stop the next', async () => {
      const service = await running();
      const seen: unknown[] = [];
      service.onCircleSignal('typing', () => {
        throw new Error('bad listener');
      });
      service.onCircleSignal('typing', (signal) => seen.push(signal));
      received('typing', { on: true });
      received('read', { on: true });
      expect(seen).toEqual([{ circleKey: CIRCLE, fromIdentity: FROM, payload: { on: true } }]);
    });

    it('sends through the process, and says when Circles aren’t running', async () => {
      const before = await load();
      expect(before.sendCircleSignal(CIRCLE, 'typing', {})).toBe(false);
      const service = await running();
      expect(service.sendCircleSignal(CIRCLE, 'typing', { on: true }, FROM)).toBe(true);
      expect(lastChild!.postMessage).toHaveBeenCalledWith({ type: 'signal-send', key: CIRCLE, topic: 'typing', payload: { on: true }, to: FROM });
    });

    it('throws on a bad topic or an oversized payload', async () => {
      const service = await running();
      expect(() => service.sendCircleSignal(CIRCLE, 'Not A Topic', {})).toThrow(/topic/);
      expect(() => service.sendCircleSignal(CIRCLE, 'typing', 'x'.repeat(5000))).toThrow(/too long/);
      expect(() => service.onCircleSignal('Not A Topic', () => undefined)).toThrow(/topic/);
    });
  });

  describe('sharing the local model', () => {
    const ME = 'ab'.repeat(32);
    const A = 'a'.repeat(64);
    const B = 'b'.repeat(64);
    const model = { id: 'qwen3-8b', contextLength: 32768, tools: true };
    const circle = (key: string, offers: unknown[] = []) => ({ key, name: key.slice(0, 1), myRole: 'member', members: [], invites: [], offers });

    async function sharingService(circles: unknown[]) {
      stored.name = 'Ada';
      const service = await load();
      fork.mockImplementationOnce(() => {
        lastChild = new FakeChild();
        const post = lastChild.postMessage.getMockImplementation()!;
        lastChild.postMessage.mockImplementation((message: { type: string }) => {
          if (message.type === 'circles-start') {
            return void setImmediate(() =>
              lastChild!.emit('message', { type: 'circles-ready', snapshot: { identity: ME, circles } })
            );
          }
          return post(message as never);
        });
        return lastChild;
      });
      await service.ensureCirclesStarted();
      const requests = () =>
        lastChild!.postMessage.mock.calls
          .map(([message]) => message as { type: string; request?: { op: string; key?: string; offer?: unknown; upstream?: unknown } })
          .filter((message) => message.type === 'circles-request')
          .map((message) => message.request!);
      return { service, requests };
    }

    it('points the gateway at the local server, publishes to chosen Circles and withdraws elsewhere', async () => {
      const mine = { identity: ME, name: 'Ada', isMine: true, models: [model], available: true, away: false, online: true };
      // Already shared with B, which matches the published offer, so the start changes nothing there.
      stored.sharing = { models: [model], circles: [B], paused: false, away: false };
      const { service, requests } = await sharingService([circle(A), circle(B, [mine])]);
      await flush();
      const atStart = requests().length;
      const result = await service.setCircleSharingSettings({ models: [{ id: ' qwen3-8b ', contextLength: 32768, tools: true }], circles: [A], paused: false, away: false });
      expect(result.success).toBe(true);
      expect(requests().slice(atStart)).toEqual([
        { op: 'share-upstream', upstream: { baseUrl: 'http://127.0.0.1:1234/v1' } },
        { op: 'publish-offer', key: A, offer: { models: [model], available: true, away: false } },
        { op: 'withdraw-offer', key: B },
      ]);
      expect(stored.sharing).toEqual({ models: [model], circles: [A], paused: false, away: false });
    });

    it('leaves an unchanged offer alone, and stops serving when nothing is shared', async () => {
      const mine = { identity: ME, name: 'Ada', isMine: true, models: [model], available: true, away: false, online: true };
      stored.sharing = { models: [model], circles: [A], paused: false, away: false };
      const { service, requests } = await sharingService([circle(A, [mine])]);
      // At start the stored settings already match the published offer.
      await flush();
      expect(requests()).toEqual([{ op: 'share-upstream', upstream: { baseUrl: 'http://127.0.0.1:1234/v1' } }]);

      await service.setCircleSharingSettings({ models: [], circles: [A], paused: false, away: false });
      expect(requests().slice(1)).toEqual([{ op: 'share-upstream', upstream: null }, { op: 'withdraw-offer', key: A }]);
    });

    it('keeps the Mac awake only while sharing in away mode, unpaused, and lets go on stop', async () => {
      const { service } = await sharingService([circle(A)]);
      await service.setCircleSharingSettings({ models: [model], circles: [A], paused: false, away: true });
      expect(blocker.running.size).toBe(1);
      await service.setCircleSharingSettings({ models: [model], circles: [A], paused: true, away: true });
      expect(blocker.running.size).toBe(0);
      await service.setCircleSharingSettings({ models: [model], circles: [A], paused: false, away: true });
      expect(blocker.running.size).toBe(1);
      await service.stopCircles();
      expect(blocker.running.size).toBe(0);
    });

    it('refuses duplicate or blank model ids and drops malformed Circle keys', async () => {
      const { service } = await sharingService([circle(A)]);
      expect((await service.setCircleSharingSettings({ models: [model, model], circles: [A], paused: false, away: false })).success).toBe(false);
      expect((await service.setCircleSharingSettings({ models: [{ id: ' ', tools: true }], circles: [A], paused: false, away: false })).success).toBe(false);
      await service.setCircleSharingSettings({ models: [model], circles: [A, 'nope'], paused: false, away: false });
      expect(stored.sharing).toMatchObject({ circles: [A] });
    });
  });
});
