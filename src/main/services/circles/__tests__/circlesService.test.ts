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
const diagnostics = vi.hoisted(() => [] as unknown[]);
vi.mock('../circlesDiagnostics', () => ({ diag: (...line: unknown[]) => void diagnostics.push(line), short: (key: string | null) => key?.slice(0, 8) ?? null }));

const NOT_SHARING = { models: [], circles: [], paused: false, away: false };
const stored = {
  name: '',
  circles: new Map<string, unknown>(),
  providers: {} as Record<string, unknown>,
  sharing: NOT_SHARING as unknown,
  wiped: [] as string[],
  inviteLabels: {} as Record<string, string>,
  inviteCodes: new Map<string, { key: string; code: string; expires: number }>(),
  saveFails: false,
  saveSecretsFails: false,
  served: undefined as unknown,
  used: undefined as unknown,
};
vi.mock('../circlesStore', () => ({
  getCirclesDisplayName: () => stored.name,
  setCirclesDisplayName: (name: string) => void (stored.name = name),
  hasCircles: () => stored.circles.size > 0,
  wipeOutdatedCircles: (dir: string) => void stored.wiped.push(dir),
  loadCircleSeeds: async () => ({ identitySeed: '11'.repeat(32), deviceSeed: '22'.repeat(32) }),
  listCircleSecrets: async () => [...stored.circles.values()],
  saveCircleSecrets: async (secrets: { key: string }) => {
    if (stored.saveSecretsFails) throw new Error('no keychain');
    stored.circles.set(secrets.key, secrets);
  },
  forgetCircle: (key: string) => {
    stored.circles.delete(key);
    for (const [id, code] of stored.inviteCodes) if (code.key === key) stored.inviteCodes.delete(id);
  },
  getProviderSettings: () => stored.providers,
  getCircleSharing: () => stored.sharing,
  getInviteLabels: () => stored.inviteLabels,
  setInviteLabels: (labels: Record<string, string>) => void (stored.inviteLabels = labels),
  getInviteCodeIds: () => [...stored.inviteCodes.keys()],
  listInviteCodeIds: (key: string) => [...stored.inviteCodes].filter(([, code]) => code.key === key).map(([id]) => id),
  saveInviteCode: async (key: string, id: string, code: string, expires: number) => {
    if (stored.saveFails) throw new Error('no keychain');
    stored.inviteCodes.set(id, { key, code, expires });
  },
  readInviteCode: async (_key: string, id: string) => stored.inviteCodes.get(id)?.code ?? null,
  forgetInviteCode: (_key: string, id: string) => void stored.inviteCodes.delete(id),
  pruneInviteCodes: (circles: Array<{ invites: Array<{ id: string; used: boolean; revoked: boolean }> }>) => {
    for (const invite of circles.flatMap((circle) => circle.invites)) {
      if (invite.used || invite.revoked) stored.inviteCodes.delete(invite.id);
    }
    return [...stored.inviteCodes.keys()];
  },
  setCircleSharing: (sharing: unknown) => void (stored.sharing = sharing),
  getServedUsage: () => stored.served,
  setServedUsage: (usage: unknown) => void (stored.served = usage),
  getUsedUsage: () => stored.used,
  setUsedUsage: (usage: unknown) => void (stored.used = usage),
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
  stored.served = undefined;
  stored.used = undefined;
  stored.name = '';
  stored.circles.clear();
  stored.providers = {};
  stored.sharing = NOT_SHARING;
  stored.inviteLabels = {};
  stored.inviteCodes.clear();
  stored.saveFails = false;
  stored.saveSecretsFails = false;
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

  it('holds a join’s failure until the user clears it', async () => {
    stored.name = 'Bo';
    const service = await load();
    fork.mockImplementationOnce(() => {
      lastChild = new FakeChild();
      lastChild.reply = () => ({ ok: false, error: 'That invite has expired. Ask for a new one.' });
      return lastChild;
    });
    await service.joinCircle('code');
    expect(service.getCirclesState().join).toEqual({ waiting: false, error: 'That invite has expired. Ask for a new one.' });
    await service.cancelJoin();
    expect(service.getCirclesState().join).toBeNull();
  });

  it('keeps one join at a time, and a cancelled join shows no failure', async () => {
    stored.name = 'Bo';
    const service = await load();
    fork.mockImplementationOnce(() => {
      lastChild = new FakeChild();
      lastChild.reply = (request) => (request.op === 'join' ? { ok: false, error: 'Join cancelled.' } : { ok: true });
      return lastChild;
    });
    const joining = service.joinCircle('code');
    expect(service.getCirclesState().join).toEqual({ waiting: true });
    expect(await service.joinCircle('other')).toMatchObject({ success: false, error: /already waiting/ });
    await service.cancelJoin();
    expect(service.getCirclesState().join).toBeNull();
    await joining;
    expect(service.getCirclesState().join).toBeNull();
  });

  it('keeps an invite’s label on this device, and sends none to the network', async () => {
    stored.name = 'Ada';
    const service = await load();
    fork.mockImplementationOnce(() => {
      lastChild = new FakeChild();
      lastChild.reply = () => ({ ok: true, invite: { id: 'i1', code: 'code', expires: Date.now() + 1000 } });
      return lastChild;
    });
    await service.createCircleInvite('c1', 1000, '  Sam ');
    expect(stored.inviteLabels).toEqual({ i1: 'Sam' });
    expect(service.getCirclesState().inviteLabels).toEqual({ i1: 'Sam' });
    const sent = lastChild!.postMessage.mock.calls.map(([message]) => JSON.stringify(message));
    expect(sent.some((message) => message.includes('"invite"'))).toBe(true);
    expect(sent.some((message) => message.includes('Sam'))).toBe(false);
  });

  describe('invite codes', () => {
    const KEY = 'c'.repeat(64);
    const open = { expires: Date.now() + 60_000, revoked: false, used: false };
    const circle = (invites: unknown[]) => ({ key: KEY, name: 'Garden', myRole: 'admin', writable: true, members: [], invites, offers: [], needsUpdate: false, writable: true });

    /** A running service whose process answers each `invite` request with the next id. */
    async function running(invites: unknown[], revoke: Record<string, unknown> = { ok: true }) {
      stored.name = 'Ada';
      const service = await load();
      let made = 0;
      fork.mockImplementationOnce(() => {
        lastChild = new FakeChild();
        lastChild.reply = (request) =>
          request.op === 'invite'
            ? { ok: true, invite: { id: `new${++made}`, code: `yrb7ei1ng${made}tail`, expires: Date.now() + 60_000 } }
            : request.op === 'revoke-invite'
              ? revoke
              : { ok: true };
        return lastChild;
      });
      await service.ensureCirclesStarted();
      lastChild!.emit('message', { type: 'circles-snapshot', snapshot: { ...SNAPSHOT, circles: [circle(invites)] } });
      return service;
    }
    const ops = () =>
      lastChild!.postMessage.mock.calls.flatMap(([message]) => (message.type === 'circles-request' ? [message.request] : []));

    it('keeps a new code out of the state and off the network', async () => {
      const service = await running([]);
      const result = await service.createCircleInvite(KEY, 1000, 'Sam');
      expect(result.success && result.invite).toMatchObject({ id: 'new1', kept: true, stillOpen: 0 });
      expect(stored.inviteCodes.get('new1')?.code).toBe('yrb7ei1ng1tail');
      expect(service.getCirclesState().inviteCodeIds).toEqual(['new1']);
      expect(JSON.stringify(service.getCirclesState())).not.toContain('yrb7ei1ng');
      expect(JSON.stringify(broadcasts)).not.toContain('yrb7ei1ng');
      expect(JSON.stringify(ops())).not.toContain('yrb7ei1ng');
      expect(JSON.stringify(diagnostics)).not.toContain('yrb7ei1ng');
    });

    it('still makes the invite when the keychain can’t keep its code', async () => {
      stored.saveFails = true;
      const service = await running([]);
      const result = await service.createCircleInvite(KEY, 1000, '');
      expect(result.success && result.invite).toMatchObject({ code: 'yrb7ei1ng1tail', kept: false });
      expect(service.getCirclesState().inviteCodeIds).toEqual([]);
    });

    it('answers hints of 9 characters, and the whole code only when asked', async () => {
      const service = await running([]);
      await service.createCircleInvite(KEY, 1000, '');
      const hints = await service.getCircleInviteHints(KEY);
      expect(hints.success && hints.hints).toEqual({ new1: 'yrb7ei1ng' });
      const code = await service.getCircleInviteCode(KEY, 'new1');
      expect(code.success && code.code).toBe('yrb7ei1ng1tail');
    });

    it('refuses a code this device doesn’t have', async () => {
      const service = await running([]);
      expect((await service.getCircleInviteCode(KEY, 'other')).success).toBe(false);
    });

    it('replaces an open invite of the same name through revoke-invite, ignoring case and spaces', async () => {
      stored.inviteLabels = { old: 'Sam', other: 'Bo' };
      stored.inviteCodes.set('old', { key: KEY, code: 'oldcode', expires: Date.now() + 60_000 });
      const service = await running([{ ...open, id: 'old' }, { ...open, id: 'other' }]);
      const result = await service.createCircleInvite(KEY, 1000, '  sAM ');
      expect(result.success).toBe(true);
      expect(ops().map((request) => request?.op)).toEqual(expect.arrayContaining(['invite', 'revoke-invite']));
      expect(ops().find((request) => request?.op === 'revoke-invite')).toMatchObject({ key: KEY, inviteId: 'old' });
      expect(ops().filter((request) => request?.op === 'revoke-invite')).toHaveLength(1);
      expect(stored.inviteCodes.has('old')).toBe(false);
      expect(stored.inviteLabels).toEqual({ other: 'Bo', new1: 'sAM' });
      expect(JSON.stringify(diagnostics)).not.toContain('yrb7ei1ng');
      expect(JSON.stringify(diagnostics)).not.toContain('oldcode');
    });

    it('leaves invites alone with no name, and in another Circle', async () => {
      stored.inviteLabels = { old: 'Sam' };
      const service = await running([{ ...open, id: 'old' }]);
      await service.createCircleInvite(KEY, 1000, '');
      await service.createCircleInvite('d'.repeat(64), 1000, 'Sam');
      expect(ops().some((request) => request?.op === 'revoke-invite')).toBe(false);
    });

    it('keeps the old invite when the new one fails', async () => {
      stored.inviteLabels = { old: 'Sam' };
      const service = await running([{ ...open, id: 'old' }]);
      lastChild!.reply = () => ({ ok: false, error: 'This Circle needs a newer version of the app.' });
      expect((await service.createCircleInvite(KEY, 1000, 'Sam')).success).toBe(false);
      expect(ops().some((request) => request?.op === 'revoke-invite')).toBe(false);
      expect(stored.inviteLabels).toEqual({ old: 'Sam' });
    });

    it('says so when the old invite can’t be revoked, and keeps its code and label', async () => {
      stored.inviteLabels = { old: 'Sam' };
      stored.inviteCodes.set('old', { key: KEY, code: 'oldcode', expires: Date.now() + 60_000 });
      const service = await running([{ ...open, id: 'old' }], { ok: false, error: 'no' });
      const result = await service.createCircleInvite(KEY, 1000, 'Sam');
      expect(result.success && result.invite.stillOpen).toBe(1);
      expect(stored.inviteCodes.has('old')).toBe(true);
      expect(stored.inviteLabels.old).toBe('Sam');
    });

    it('drops a code when its invite is revoked or used, and when its Circle goes', async () => {
      const service = await running([]);
      await service.createCircleInvite(KEY, 1000, '');
      await service.createCircleInvite(KEY, 1000, '');
      await service.revokeCircleInvite(KEY, 'new1');
      expect(service.getCirclesState().inviteCodeIds).toEqual(['new2']);
      lastChild!.emit('message', { type: 'circles-snapshot', snapshot: { ...SNAPSHOT, circles: [circle([{ ...open, id: 'new2', used: true }])] } });
      expect(service.getCirclesState().inviteCodeIds).toEqual([]);

      await service.createCircleInvite(KEY, 1000, '');
      await service.leaveCircle(KEY);
      expect(service.getCirclesState().inviteCodeIds).toEqual([]);
      stored.circles.set(KEY, { key: KEY });
      await service.createCircleInvite(KEY, 1000, '');
      lastChild!.emit('message', { type: 'circle-removed', key: KEY });
      expect(service.getCirclesState().inviteCodeIds).toEqual([]);
    });
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

  it('forgets a Circle it has deleted', async () => {
    stored.name = 'Ada';
    stored.circles.set('c1', { namespace: 'n1', key: 'c1' });
    const service = await load();
    expect(await service.deleteCircle('c1')).toMatchObject({ success: true });
    expect(stored.circles.has('c1')).toBe(false);
    await service.stopCircles();
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

  describe('a join after admission', () => {
    const paired = { type: 'circle-paired', secrets: { namespace: 'n1', key: 'c1', encryptionKey: 'e1' } };

    /** A join in progress, whose `answer` ends the network request. */
    async function joining() {
      stored.name = 'Bo';
      const service = await load();
      await service.ensureCirclesStarted();
      let answer!: (reply: Record<string, unknown>) => void;
      lastChild!.postMessage.mockImplementation((message: { type: string; id?: number; request?: { op: string } }) => {
        if (message.type !== 'circles-request') return;
        const reply = (body: Record<string, unknown>) => lastChild!.emit('message', { type: 'circles-reply', id: message.id, ...body });
        if (message.request?.op === 'join') answer = reply;
        else setImmediate(() => reply({ ok: true }));
      });
      const result = service.joinCircle('code');
      await flush();
      return { service, result, answer: (reply: Record<string, unknown>) => answer(reply) };
    }

    it('ends the join at admission, and a cancel afterwards sends nothing', async () => {
      const { service, result, answer } = await joining();
      expect(service.getCirclesState().join).toEqual({ waiting: true });
      lastChild!.emit('message', paired);
      expect(service.getCirclesState()).toMatchObject({ join: null, finishingJoin: 'c1' });

      const sent = lastChild!.postMessage.mock.calls.length;
      await service.cancelJoin();
      expect(lastChild!.postMessage.mock.calls.length).toBe(sent);
      expect((await service.joinCircle('another')).success).toBe(false);

      answer({ ok: true, secrets: { ...paired.secrets, name: 'Garden' } });
      expect(await result).toMatchObject({ success: true, key: 'c1' });
      expect(service.getCirclesState()).toMatchObject({ join: null, finishingJoin: null });
    });

    it('still joins when a cancel lands just before admission', async () => {
      const { service, result, answer } = await joining();
      await service.cancelJoin();
      lastChild!.emit('message', paired);
      expect(service.getCirclesState().finishingJoin).toBe('c1');
      answer({ ok: true, secrets: { ...paired.secrets, name: 'Garden' } });
      await result;
      expect(stored.circles.has('c1')).toBe(true);
      expect(service.getCirclesState().join).toBeNull();
    });

    it('says the secrets are safe when opening fails after admission', async () => {
      const { service, result, answer } = await joining();
      lastChild!.emit('message', paired);
      await flush();
      answer({ ok: false, error: 'boot failed' });
      await result;
      expect(service.getCirclesState().finishingJoin).toBeNull();
      expect(service.getCirclesState().join?.error).toMatch(/joined, but the Circle couldn’t open\. Restart/);
      expect(stored.circles.has('c1')).toBe(true);
    });

    it('says so when the keychain refused the secrets', async () => {
      const { service, result, answer } = await joining();
      stored.saveSecretsFails = true;
      lastChild!.emit('message', paired);
      await flush();
      answer({ ok: false, error: 'boot failed' });
      await result;
      expect(service.getCirclesState().join?.error).toMatch(/keychain couldn’t keep the Circle’s key/);
    });

    it('holds a Circle’s offer until it can write, then publishes it', async () => {
      stored.name = 'Bo';
      stored.sharing = { models: [{ id: 'm', tools: true }], circles: ['c'.repeat(64)], paused: false, away: false };
      const service = await load();
      await service.ensureCirclesStarted();
      await flush();
      const circle = (writable: boolean) => ({ key: 'c'.repeat(64), name: 'G', myRole: 'member', writable: true, members: [], invites: [], offers: [], needsUpdate: false, writable });
      const ops = () => lastChild!.postMessage.mock.calls.flatMap(([message]) => (message.type === 'circles-request' ? [message.request!.op] : []));
      lastChild!.emit('message', { type: 'circles-snapshot', snapshot: { ...SNAPSHOT, circles: [circle(false)] } });
      await service.setCircleSharingSettings(stored.sharing as never);
      expect(ops()).not.toContain('publish-offer');
      lastChild!.emit('message', { type: 'circles-snapshot', snapshot: { ...SNAPSHOT, circles: [circle(true)] } });
      await flush();
      expect(ops()).toContain('publish-offer');
    });
  });

  it('keeps a joined Circle from the moment it is admitted, before the join finishes', async () => {
    stored.name = 'Bo';
    const service = await load();
    await service.ensureCirclesStarted();
    lastChild!.emit('message', { type: 'circle-paired', secrets: { namespace: 'n1', key: 'c1', encryptionKey: 'e1' } });
    await flush();
    expect(stored.circles.has('c1')).toBe(true);
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

    it('counts the user’s own use of a provider from the replies it answered', async () => {
      const { service, lastRequest, reply } = await running();
      const pending = service.fetchSharedModel(PEER, { method: 'POST', path: '/v1/chat/completions' });
      const { id } = lastRequest();
      reply({ type: 'shared-head', id, status: 200, contentType: 'text/event-stream' });
      const response = await pending;
      reply({ type: 'shared-chunk', id, data: new TextEncoder().encode('data: {"usage":{"total_tokens":12}}\n\n') });
      reply({ type: 'shared-end', id });
      await response.text();

      const refused = service.fetchSharedModel(PEER, { method: 'POST', path: '/v1/chat/completions' });
      const second = lastRequest().id;
      reply({ type: 'shared-head', id: second, status: 429, contentType: 'application/json' });
      const answer = await refused;
      reply({ type: 'shared-end', id: second });
      await answer.text();

      expect(service.getCirclesState().used?.counts[PEER.providerId]).toEqual({ requests: 1, tokens: 12 });
      expect(stored.used).toEqual(service.getCirclesState().used);
    });

    it('keeps what the gateway counted, and gives it back to the next start', async () => {
      const { service, reply, child } = await running();
      const served = { day: '2026-10-31', counts: { [PEER.providerId]: { requests: 2, tokens: 40 } } };
      reply({ type: 'share-usage', served, serving: { running: PEER.providerId, queued: [] } });
      expect(service.getCirclesState().serving?.running).toBe(PEER.providerId);
      expect(stored.served).toEqual(served);
      child.emit('exit', 0);
      expect(service.getCirclesState().serving).toBeNull();
      await service.ensureCirclesStarted();
      const start = lastChild!.postMessage.mock.calls.map(([message]) => message as { type: string; usage?: unknown }).find((message) => message.type === 'circles-start');
      expect(start?.usage).toEqual(served);
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
              writable: true,
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
    const circle = (key: string, offers: unknown[] = []) => ({ key, name: key.slice(0, 1), myRole: 'member', writable: true, members: [], invites: [], offers });

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

    it('sends cleaned limits to the gateway, and keeps them when a change leaves them out', async () => {
      const { service, requests } = await sharingService([circle(A)]);
      await flush();
      const limits = {
        everyone: { requestsPerDay: 5, tokensPerDay: -1, concurrent: 1.5 },
        members: { [B]: { tokensPerDay: 100 }, 'not-an-identity': { requestsPerDay: 1 } },
      };
      await service.setCircleSharingSettings({ models: [model], circles: [A], paused: false, away: false, limits });
      const cleaned = { everyone: { requestsPerDay: 5 }, members: { [B]: { tokensPerDay: 100 } } };
      expect(requests().filter((request) => request.op === 'share-upstream').at(-1)).toMatchObject({ limits: cleaned });
      const result = await service.setCircleSharingSettings({ models: [model], circles: [A], paused: true, away: false });
      expect(result.state.sharing.limits).toEqual(cleaned);
    });

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

  describe('records', () => {
    const KEY = 'c'.repeat(64);

    it('tells the network which apps are listened to, until the last listener stops', async () => {
      stored.name = 'Ada';
      const service = await load();
      await service.ensureCirclesStarted();
      const stop = service.onCircleRecord('profile', () => undefined);
      expect(lastChild!.postMessage).toHaveBeenCalledWith({ type: 'record-apps', apps: ['profile'] });
      stop();
      expect(lastChild!.postMessage).toHaveBeenLastCalledWith({ type: 'record-apps', apps: [] });
    });

    it('passes changes to the app’s listeners, past one that throws', async () => {
      stored.name = 'Ada';
      const service = await load();
      await service.ensureCirclesStarted();
      const heard = vi.fn();
      service.onCircleRecord('profile', () => {
        throw new Error('no');
      });
      service.onCircleRecord('profile', heard);
      const other = vi.fn();
      service.onCircleRecord('other', other);
      const change = { app: 'profile', scope: 'member', identity: 'a', key: 'bio', value: 1, circleKey: KEY, confirmed: false, deleted: false };
      lastChild!.emit('message', { type: 'record-changed', change });
      expect(heard).toHaveBeenCalledWith(change);
      expect(other).not.toHaveBeenCalled();
    });

    it('refuses an app name that isn’t one', async () => {
      const service = await load();
      expect(() => service.onCircleRecord('a/b', () => undefined)).toThrow();
    });

    it('sets, deletes and lists through the network', async () => {
      stored.name = 'Ada';
      const service = await load();
      await service.ensureCirclesStarted();
      const records = [{ app: 'profile' }];
      lastChild!.reply = (request) => (request.op === 'records-list' ? { ok: true, records } : { ok: true });
      expect((await service.setCircleRecord(KEY, 'profile', 'member', 'bio', { a: 1 })).success).toBe(true);
      expect((await service.deleteCircleRecord(KEY, 'profile', 'member', 'bio')).success).toBe(true);
      const listed = await service.getCircleRecords(KEY, 'profile');
      expect(listed.success && listed.records).toEqual(records);
    });

    it('answers with the network’s refusal', async () => {
      stored.name = 'Ada';
      const service = await load();
      await service.ensureCirclesStarted();
      lastChild!.reply = () => ({ ok: false, error: 'Only admins can change this Circle’s records.' });
      const result = await service.setCircleRecord(KEY, 'settings', 'circle', 'topic', 1);
      expect(result).toMatchObject({ success: false, error: 'Only admins can change this Circle’s records.' });
    });
  });
});
