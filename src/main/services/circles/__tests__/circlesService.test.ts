import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CircleInviteView,
  CircleMemberView,
  CircleMessage,
  CircleOfferView,
  CircleSharing,
  CircleSnapshot,
  CirclesSnapshot,
} from '../../../../shared/types/circles';
import type { CircleRecordChange } from '../networkMessages';
import type { CirclesSharing } from '../sharingConfig';

const SNAPSHOT: CirclesSnapshot = { identity: 'ab'.repeat(32), circles: [] };

/** A fake network process: answers `circles-start` with ready, and requests with `reply`. */
class FakeChild extends EventEmitter {
  pid = 42;
  stderr = new PassThrough();
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
vi.mock('../../windows', () => ({ broadcast: (_channel: string, payload: unknown) => broadcasts.push(payload) }));
const debugLog = vi.hoisted(() => [] as Array<{ message: string; data: unknown }>);
vi.mock('../../../persistDebugLog', () => ({
  persistDebugLog: (_area: string, message: string, data: unknown): void => void debugLog.push({ message, data }),
}));
const notices = vi.hoisted(() => [] as Array<{ title: string; body: string }>);
const noticeClicks = vi.hoisted(() => [] as Array<((win: unknown) => void) | undefined>);
vi.mock('../../notifications', () => ({
  showWindowNotification: (notice: { title: string; body: string }, onClick?: (win: unknown) => void): void => {
    notices.push(notice);
    noticeClicks.push(onClick);
  },
}));
const sentEvents = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../../ipc', () => ({ sendEvent: (_contents: unknown, ...args: unknown[]): void => void sentEvents.push(args) }));
const diagnostics = vi.hoisted(() => [] as unknown[]);
vi.mock('../circlesDiagnostics', () => ({ diag: (...line: unknown[]): void => void diagnostics.push(line), short: (key: string | null) => key?.slice(0, 8) ?? null }));

const NOT_SHARING: CircleSharing = { models: [], circles: [], paused: false, away: false };
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
  servedServices: undefined as unknown,
  serviceGrants: { grants: [], revoke: [] } as { grants: unknown[]; revoke: string[] },
  reads: {} as Record<string, Record<string, unknown>>,
};
vi.mock('../circlesStore', () => ({
  getCirclesDisplayName: () => stored.name,
  setCirclesDisplayName: (name: string): void => void (stored.name = name),
  hasCircles: () => stored.circles.size > 0,
  wipeOutdatedCircles: (dir: string): void => void stored.wiped.push(dir),
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
  markCircleLeaving: (key: string) => {
    const secrets = stored.circles.get(key) as object | undefined;
    if (secrets) stored.circles.set(key, { ...secrets, leaving: true });
    for (const [id, code] of stored.inviteCodes) if (code.key === key) stored.inviteCodes.delete(id);
  },
  getProviderSettings: () => stored.providers,
  getCircleSharing: () => stored.sharing,
  getInviteLabels: () => stored.inviteLabels,
  setInviteLabels: (labels: Record<string, string>): void => void (stored.inviteLabels = labels),
  getInviteCodeIds: () => [...stored.inviteCodes.keys()],
  listInviteCodeIds: (key: string) => [...stored.inviteCodes].filter(([, code]) => code.key === key).map(([id]) => id),
  saveInviteCode: async (key: string, id: string, code: string, expires: number) => {
    if (stored.saveFails) throw new Error('no keychain');
    stored.inviteCodes.set(id, { key, code, expires });
  },
  readInviteCode: async (_key: string, id: string) => stored.inviteCodes.get(id)?.code ?? null,
  forgetInviteCode: (_key: string, id: string): void => void stored.inviteCodes.delete(id),
  pruneInviteCodes: (circles: Array<{ invites: Array<{ id: string; used: boolean; revoked: boolean }> }>) => {
    for (const invite of circles.flatMap((circle) => circle.invites)) {
      if (invite.used || invite.revoked) stored.inviteCodes.delete(invite.id);
    }
    return [...stored.inviteCodes.keys()];
  },
  setCircleSharing: (sharing: unknown): void => void (stored.sharing = sharing),
  getNotifyPrefs: () => ({ level: 'default', channelMentions: true }),
  getNotifyGlobal: () => ({ enabled: true, showText: true }),
  getReadPositions: (key: string) => stored.reads[key] ?? {},
  setReadPosition: (key: string, channel: string, position: unknown) => {
    stored.reads = { ...stored.reads, [key]: { ...stored.reads[key], [channel]: position } };
  },
  getServedUsage: () => stored.served,
  setServedUsage: (usage: unknown): void => void (stored.served = usage),
  getUsedUsage: () => stored.used,
  getServedServiceUsage: () => stored.servedServices,
  setServedServiceUsage: (usage: unknown): void => void (stored.servedServices = usage),
  loadServiceGrants: async () => stored.serviceGrants,
  saveServiceGrants: async (state: typeof stored.serviceGrants): Promise<void> => void (stored.serviceGrants = state),
  setUsedUsage: (usage: unknown): void => void (stored.used = usage),
  setProviderSettings: (identity: string, settings: { private: boolean; trusted: boolean }) => {
    stored.providers = { ...stored.providers, [identity]: settings };
  },
}));

/** What the app supplies through the configuration point; only the local model matters here. */
const sharing = (): CirclesSharing =>
  ({
    localModel: async () => ({ endpointUrl: 'http://127.0.0.1:1234/v1' }),
    services: { mintKeys: vi.fn(), revokeKeys: vi.fn(), upstreamFor: vi.fn() },
    workspaces: vi.fn(),
    pending: vi.fn(),
    exclusive: vi.fn(),
    hasHostCallbacks: vi.fn(),
    requireHostCallbacks: vi.fn(),
    folders: { refuseReason: vi.fn(), facts: vi.fn() },
    agentGuard: { check: vi.fn(), readBody: vi.fn() },
  }) as unknown as CirclesSharing;

async function load({ configure = true } = {}) {
  vi.resetModules();
  const service = await import('../circlesService');
  if (configure) (await import('../sharingConfig')).configureCircles(sharing());
  return service;
}

beforeEach(() => {
  fork.mockClear();
  lastChild = null;
  debugLog.length = 0;
  broadcasts.length = 0;
  notices.length = 0;
  noticeClicks.length = 0;
  sentEvents.length = 0;
  stored.served = undefined;
  stored.used = undefined;
  stored.servedServices = undefined;
  stored.serviceGrants = { grants: [], revoke: [] };
  stored.name = '';
  stored.circles.clear();
  stored.providers = {};
  stored.sharing = NOT_SHARING;
  stored.inviteLabels = {};
  stored.inviteCodes.clear();
  stored.reads = {};
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

  it('hands the gateway stored grants when Circles start, and keeps the day’s service counts', async () => {
    stored.name = 'Ada';
    stored.circles.set('c1', { namespace: 'n1', key: 'c1', encryptionKey: 'e1' });
    const usage = { day: '2026-11-09', counts: { bo: { requests: 2, tokens: 0 } } };
    stored.servedServices = usage;
    stored.serviceGrants = {
      grants: [{ circle: 'c1', service: 'twenty.main', identity: 'bo', level: 'read', read: { id: 'k1', token: 't1' } }],
      revoke: [],
    };
    const service = await load();
    await service.ensureCirclesStarted();
    await flush();

    const sent = lastChild!.postMessage.mock.calls.map(([message]) => message as { type: string; request?: { op: string } });
    expect(sent).toContainEqual(expect.objectContaining({ type: 'circles-start', serviceUsage: usage }));
    const sharing = sent.find((message) => message.request?.op === 'service-sharing');
    expect(sharing?.request).toMatchObject({
      sharing: { grants: [{ circle: 'c1', service: 'twenty.main', identity: 'bo', read: 't1' }] },
    });
    expect(JSON.stringify(debugLog)).not.toContain('t1');

    const later = { day: '2026-11-09', counts: { bo: { requests: 3, tokens: 0 } } };
    lastChild!.emit('message', { type: 'service-usage', served: later });
    expect(stored.servedServices).toEqual(later);
  });

  it('sends the gateway nothing at start when no one has been granted a service', async () => {
    stored.name = 'Ada';
    stored.circles.set('c1', { namespace: 'n1', key: 'c1', encryptionKey: 'e1' });
    const service = await load();
    await service.ensureCirclesStarted();
    await flush();
    const ops = lastChild!.postMessage.mock.calls.map(([message]) => (message as { request?: { op: string } }).request?.op);
    expect(ops).not.toContain('service-sharing');
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
    const circle = (invites: CircleInviteView[]): CircleSnapshot => ({ key: KEY, name: 'Garden', myRole: 'admin', members: [], invites, offers: [], needsUpdate: false, writable: true, format: 2 });

    /** A running service whose process answers each `invite` request with the next id. */
    async function running(invites: CircleInviteView[], revoke: Record<string, unknown> = { ok: true }) {
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

  it('pipes the process’s stderr and logs its tail when the process dies unexpectedly', async () => {
    stored.name = 'Bo';
    const service = await load();
    await service.ensureCirclesStarted();
    expect(fork).toHaveBeenCalledWith(expect.any(String), [], expect.objectContaining({ stdio: ['ignore', 'inherit', 'pipe'] }));

    const child = lastChild!;
    child.stderr.end('TypeError: boom\n    at open (circlesNetwork.js:1:2)\n');
    child.emit('exit', 1);
    await flush();

    expect(service.getCirclesState()).toMatchObject({ status: 'failed', error: 'Circles stopped unexpectedly.' });
    expect(debugLog).toContainEqual({
      message: 'network process stderr',
      data: { code: 1, bytes: 52, tail: 'TypeError: boom\n    at open (circlesNetwork.js:1:2)\n' },
    });
  });

  it('logs no stderr when the process stops because it was asked to', async () => {
    stored.name = 'Bo';
    const service = await load();
    await service.ensureCirclesStarted();
    lastChild!.stderr.end('a warning\n');
    await service.stopCircles();
    await flush();

    expect(debugLog.find((line) => line.message === 'network process stderr')).toBeUndefined();
  });

  it('keeps a Circle it has left until the network process closes it, and starts at launch only for a member', async () => {
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
    // Kept so the leave reaches an admin after a restart; the process opens it as leaving.
    expect(stored.circles.get('c1')).toEqual({ namespace: 'n1', key: 'c1', leaving: true });
    lastChild!.emit('message', { type: 'circle-removed', key: 'c1' });
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

  it('tells an admin who left, with a notification', async () => {
    stored.name = 'Ada';
    stored.circles.set('c1', { namespace: 'n1', key: 'c1' });
    const service = await load();
    await service.ensureCirclesStarted();
    lastChild!.emit('message', { type: 'member-left', key: 'c1', circle: 'Garden club', name: 'Bo' });
    expect(notices).toEqual([{ title: 'Garden club', body: 'Bo left the Circle.' }]);
    await service.stopCircles();
  });

  it('keeps calling removal handlers after one throws, and logs only the registry and error class', async () => {
    stored.name = 'Bo';
    stored.circles.set('c1', { namespace: 'n1', key: 'c1' });
    const service = await load();
    await service.ensureCirclesStarted();
    service.onCircleRemoved(() => {
      throw new Error('secret detail');
    });
    const heard: string[] = [];
    service.onCircleRemoved((key) => heard.push(key));
    lastChild!.emit('message', { type: 'circle-removed', key: 'c1' });
    expect(heard).toEqual(['c1']);
    expect(stored.circles.has('c1')).toBe(false);
    expect(diagnostics).toContainEqual(['main.handler-failed', { registry: 'removed', error: 'Error' }]);
    expect(JSON.stringify(diagnostics)).not.toContain('secret detail');
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
      const circle = (writable: boolean): CircleSnapshot => ({ key: 'c'.repeat(64), name: 'G', myRole: 'member', members: [], invites: [], offers: [], needsUpdate: false, writable, format: 2 });
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

    it('posts the topics again only when a topic gains its first listener or loses its last', async () => {
      const service = await running();
      const stopA = service.onCircleSignal('typing', () => undefined);
      const stopB = service.onCircleSignal('typing', () => undefined);
      expect(topicsPosted()).toEqual([{ type: 'signal-topics', topics: [] }, { type: 'signal-topics', topics: ['typing'] }]);
      stopA();
      expect(topicsPosted()).toHaveLength(2);
      stopB();
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
    const circle = (key: string, offers: CircleOfferView[] = []) => ({ key, name: key.slice(0, 1), myRole: 'member', writable: true, members: [] as CircleMemberView[], invites: [] as CircleInviteView[], offers });

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

  describe('chat', () => {
    const KEY = 'cd'.repeat(32);
    const ME = SNAPSHOT.identity;
    const ID = '0123456789abcdef';
    const requests = () =>
      lastChild!.postMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === 'circles-request')
        .map((message) => message.request as { op: string } & Record<string, unknown>);

    async function running(reply: (request: { op: string }) => Record<string, unknown> = () => ({ ok: true })) {
      const service = await load();
      stored.name = 'Ada';
      await service.setDisplayName('Ada');
      await service.ensureCirclesStarted();
      lastChild!.reply = reply;
      await flush();
      return service;
    }

    const message = (text: string, extra: Partial<CircleMessage> = {}): CircleMessage => ({
      circleKey: KEY,
      channel: 'general',
      author: ME,
      id: ID,
      name: 'Ada',
      agent: null,
      text,
      at: 1,
      confirmed: false,
      edited: false,
      deleted: null,
      shared: null,
      call: null,
      mentions: null,
      reply: null,
      reactions: [],
      mine: true,
      ...extra,
    });

    it('sends this device’s read positions with a channels request', async () => {
      stored.reads = { [KEY]: { general: { author: ME, id: ID, at: 1 } } };
      const channels = [{ id: 'general', name: 'General', unread: 2 }];
      const service = await running(() => ({ ok: true, chat: { channels } }));
      expect(await service.listCircleChannels(KEY)).toMatchObject({ success: true, channels });
      expect(requests().at(-1)).toEqual({ op: 'chat-channels', key: KEY, reads: stored.reads[KEY], channelMentions: true });
    });

    it('asks for 50 messages by default and at most 200', async () => {
      const service = await running(() => ({ ok: true, chat: { messages: [], more: false } }));
      await service.getCircleMessages(KEY, 'general');
      await service.getCircleMessages(KEY, 'general', { before: { author: ME, id: ID }, limit: 5_000 });
      const reads = requests().filter((request) => request.op === 'chat-messages');
      expect(reads.map((request) => request.limit)).toEqual([50, 200]);
      expect(reads.at(-1)?.before).toEqual({ author: ME, id: ID });
    });

    it('counts a channel read up to the user’s own new message, and not after a refusal', async () => {
      let ok = true;
      const service = await running(() =>
        ok ? { ok: true, chat: { id: ID } } : { ok: false, error: 'That channel isn’t in this Circle.' }
      );
      expect(await service.postCircleMessage(KEY, 'general', 'Hello')).toMatchObject({ success: true, id: ID });
      expect(stored.reads[KEY]?.general).toMatchObject({ author: ME, id: ID });
      ok = false;
      const refused = await service.postCircleMessage(KEY, 'garden', 'Hello');
      expect(refused).toMatchObject({ success: false, error: 'That channel isn’t in this Circle.' });
      expect(stored.reads[KEY]?.garden).toBeUndefined();
    });

    it('passes where shared text came from with the post', async () => {
      const service = await running(() => ({ ok: true, chat: { id: ID } }));
      await service.postCircleMessage(KEY, 'general', 'Summary', { shared: { role: 'assistant', model: 'qwen3-8b' } });
      expect(requests().at(-1)).toEqual({
        op: 'chat-post',
        key: KEY,
        channel: 'general',
        text: 'Summary',
        shared: { role: 'assistant', model: 'qwen3-8b' },
      });
    });

    it('sends the mentions still in the text with a post or an edit, and none when nothing is kept', async () => {
      const service = await running(() => ({ ok: true, chat: { id: ID } }));
      const maya = { identity: 'c'.repeat(64), name: 'Maya' };
      await service.postCircleMessage(KEY, 'general', 'Hi @Maya @channel', { picked: [maya], mentionChannel: true });
      expect(requests().at(-1)).toMatchObject({ op: 'chat-post', mentions: { members: [maya.identity], channel: true } });
      await service.postCircleMessage(KEY, 'general', 'Hi', { picked: [maya], mentionChannel: true });
      expect(requests().at(-1)).not.toHaveProperty('mentions');
      await service.editCircleMessage(KEY, 'general', ID, 'Hi @Maya', { picked: [maya] });
      expect(requests().at(-1)).toMatchObject({ op: 'chat-edit', text: 'Hi @Maya', mentions: { members: [maya.identity] } });
      await service.editCircleMessage(KEY, 'general', ID, 'Hi');
      expect(requests().at(-1)).not.toHaveProperty('mentions');
    });

    it('sends a reply with a post and leaves it out when absent', async () => {
      const service = await running(() => ({ ok: true, chat: { id: ID } }));
      const reply = { author: ME, id: ID };
      await service.postCircleMessage(KEY, 'general', 'Yes', { reply });
      expect(requests().at(-1)).toEqual({ op: 'chat-post', key: KEY, channel: 'general', text: 'Yes', reply });
      await service.postCircleMessage(KEY, 'general', 'No');
      expect(requests().at(-1)).not.toHaveProperty('reply');
    });

    it('asks for one message by reference', async () => {
      const found = { id: ID, text: 'Hello' };
      const service = await running(() => ({ ok: true, chat: { message: found } }));
      expect(await service.getCircleMessage(KEY, 'general', { author: ME, id: ID })).toMatchObject({ success: true, message: found });
      expect(requests().at(-1)).toEqual({ op: 'chat-message', key: KEY, channel: 'general', ref: { author: ME, id: ID } });
      const missing = await running(() => ({ ok: true, chat: { message: null } }));
      expect(await missing.getCircleMessage(KEY, 'general', { author: ME, id: ID })).toMatchObject({ success: true, message: null });
    });

    it('keeps a read position on this device only, and refuses one that isn’t', async () => {
      const service = await running();
      const sent = requests().length;
      expect(service.markCircleChannelRead(KEY, 'general', { author: ME, id: ID, at: 3 })).toMatchObject({ success: true });
      expect(stored.reads[KEY]?.general).toEqual({ author: ME, id: ID, at: 3, reactionsAt: expect.any(Number) });
      expect(service.markCircleChannelRead(KEY, 'general', { author: ME, id: 'not-hex', at: 3 })).toMatchObject({ success: false });
      expect(service.markCircleChannelRead(KEY, 'Bad Channel', { author: ME, id: ID, at: 3 })).toMatchObject({ success: false });
      expect(requests().length).toBe(sent);
    });

    it('marking read stores reactionsAt from this device’s clock', async () => {
      const service = await running();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_700_000_000_000);
        service.markCircleChannelRead(KEY, 'general', { author: ME, id: ID, at: 3, reactionsAt: 5 } as never);
        expect(stored.reads[KEY]?.general).toEqual({ author: ME, id: ID, at: 3, reactionsAt: 1_700_000_000_000 });
      } finally {
        vi.useRealTimers();
      }
    });

    describe('channels', () => {
      const channels = [
        { id: 'general', name: 'General', unread: 0 },
        { id: 'garden-a1b2c3', name: 'Garden', unread: 0 },
      ];
      const reply = (request: { op: string }) =>
        request.op === 'chat-channels' ? { ok: true, chat: { channels } } : { ok: true };
      const recordRequests = () => requests().filter((request) => request.op.startsWith('record-'));

      it('adds a channel as a Circle record with a random ending', async () => {
        const service = await running(reply);
        const added = await service.addCircleChannel(KEY, '  Book Picks! ');
        expect(added).toMatchObject({ success: true, id: expect.stringMatching(/^book-picks-[0-9a-f]{6}$/) });
        expect(recordRequests()).toEqual([
          {
            op: 'record-set',
            key: KEY,
            app: 'chat',
            scope: 'circle',
            record: (added as { id: string }).id,
            value: { name: 'Book Picks!' },
          },
        ]);
      });

      it('cuts the id at 48 characters and falls back to channel', async () => {
        const service = await running(reply);
        const long = await service.addCircleChannel(KEY, `${'a'.repeat(47)} b`);
        expect(long).toMatchObject({ success: true, id: expect.stringMatching(/^a{47}-[0-9a-f]{6}$/) });
        const symbols = await service.addCircleChannel(KEY, '¿¡!');
        expect(symbols).toMatchObject({ success: true, id: expect.stringMatching(/^channel-[0-9a-f]{6}$/) });
        const accented = await service.addCircleChannel(KEY, 'Café Chat');
        expect(accented).toMatchObject({ success: true, id: expect.stringMatching(/^caf-chat-[0-9a-f]{6}$/) });
      });

      it('refuses an empty or taken name before writing', async () => {
        const service = await running(reply);
        expect(await service.addCircleChannel(KEY, '  ')).toMatchObject({ success: false, error: 'Enter a name.' });
        expect(await service.addCircleChannel(KEY, 'garden')).toMatchObject({
          success: false,
          error: 'This Circle already has a channel with that name.',
        });
        expect(await service.renameCircleChannel(KEY, 'garden-a1b2c3', 'Garden')).toMatchObject({ success: true });
        expect(recordRequests()).toHaveLength(1);
      });

      it('renames General, never removes it, and removes others by deleting their record', async () => {
        const service = await running(reply);
        await service.renameCircleChannel(KEY, 'general', 'Lobby');
        expect(await service.removeCircleChannel(KEY, 'general')).toMatchObject({ success: false, error: 'General can’t be removed.' });
        await service.removeCircleChannel(KEY, 'garden-a1b2c3');
        expect(recordRequests()).toEqual([
          { op: 'record-set', key: KEY, app: 'chat', scope: 'circle', record: 'general', value: { name: 'Lobby' } },
          { op: 'record-del', key: KEY, app: 'chat', scope: 'circle', record: 'garden-a1b2c3' },
        ]);
      });

      it('tells the renderer when a Circle record of the chat app changes', async () => {
        const service = await running();
        service.listenForChannelChanges();
        const change: CircleRecordChange = { circleKey: KEY, app: 'chat', scope: 'circle', identity: null, key: 'garden', value: { name: 'G' }, confirmed: false, deleted: false };
        lastChild!.emit('message', { type: 'record-changed', change });
        lastChild!.emit('message', { type: 'record-changed', change: { ...change, scope: 'member', identity: ME } });
        expect(broadcasts.filter((payload) => JSON.stringify(payload) === JSON.stringify({ circleKey: KEY }))).toHaveLength(1);
      });
    });

    describe('notifications', () => {
      const OTHER = 'ef'.repeat(32);
      const member = (identity: string, name: string) => ({ identity, name });

      /** A running service whose snapshot holds the Circle, with fake timers for the batch window only. */
      async function withCircle() {
        const service = await running(() => ({ ok: true, chat: { channels: [{ id: 'general', name: 'general', unread: 0 }] } }));
        const circle = { key: KEY, name: 'Garden club', members: [member(ME, 'Ada'), member(OTHER, 'Bo')], invites: [] as unknown[], offers: [] as unknown[] };
        lastChild!.emit('message', { type: 'circles-snapshot', snapshot: { identity: ME, circles: [circle] } });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        return service;
      }
      const settle = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
        await flush();
      };
      const fromBo = () => message('Hello there', { author: OTHER, name: 'Bo', mine: false });

      afterEach(() => void vi.useRealTimers());

      it('notifies for another member’s message after the batch window', async () => {
        await withCircle();
        lastChild!.emit('message', { type: 'chat-update', update: { circleKey: KEY, channel: 'general', added: [fromBo()], changed: [], gone: [] } });
        await settle(1_499);
        expect(notices).toEqual([]);
        await settle(1);
        expect(notices).toMatchObject([{ title: 'Bo in #general · Garden club', body: 'Hello there' }]);
      });

      it('sends circles:open-message with the message when the notification is clicked', async () => {
        await withCircle();
        lastChild!.emit('message', { type: 'chat-update', update: { circleKey: KEY, channel: 'general', added: [fromBo()], changed: [], gone: [] } });
        await settle(1_500);
        noticeClicks[0]!({ webContents: {} });
        expect(sentEvents).toEqual([['circles:open-message', { circleKey: KEY, channel: 'general', ref: { author: OTHER, id: ID } }]]);
      });

      it('stays silent when the channel is marked read inside the window', async () => {
        const service = await withCircle();
        lastChild!.emit('message', { type: 'chat-update', update: { circleKey: KEY, channel: 'general', added: [fromBo()], changed: [], gone: [] } });
        service.markCircleChannelRead(KEY, 'general', { author: OTHER, id: ID, at: 1 });
        await settle(1_500);
        expect(notices).toEqual([]);
      });

      it('stays silent for the channel on screen with the window focused', async () => {
        const service = await withCircle();
        service.setCircleViewing({ circleKey: KEY, channel: 'general', focused: true });
        lastChild!.emit('message', { type: 'chat-update', update: { circleKey: KEY, channel: 'general', added: [fromBo()], changed: [], gone: [] } });
        await settle(1_500);
        expect(notices).toEqual([]);
      });

      it('keeps the viewed channel silent after the network process restarts', async () => {
        const service = await withCircle();
        service.setCircleViewing({ circleKey: KEY, channel: 'general', focused: true });
        lastChild!.emit('exit', 1);
        // Real timers while the new process starts: its answers come on setImmediate.
        vi.useRealTimers();
        await service.ensureCirclesStarted();
        const circle = { key: KEY, name: 'Garden club', members: [member(ME, 'Ada'), member(OTHER, 'Bo')], invites: [] as unknown[], offers: [] as unknown[] };
        lastChild!.emit('message', { type: 'circles-snapshot', snapshot: { identity: ME, circles: [circle] } });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        lastChild!.emit('message', { type: 'chat-update', update: { circleKey: KEY, channel: 'general', added: [fromBo()], changed: [], gone: [] } });
        await settle(1_500);
        expect(notices).toEqual([]);
      });

      it('shows a message’s edited text, and nothing for one deleted inside the window', async () => {
        await withCircle();
        const kept = fromBo();
        const doomed = message('Wrong channel', { author: OTHER, name: 'Bo', mine: false, id: 'fedcba9876543210' });
        lastChild!.emit('message', { type: 'chat-update', update: { circleKey: KEY, channel: 'general', added: [kept, doomed], changed: [], gone: [] } });
        const changed = [{ ...kept, text: 'Hello there, all', edited: true }, { ...doomed, text: '', deleted: 'author' }];
        lastChild!.emit('message', { type: 'chat-update', update: { circleKey: KEY, channel: 'general', added: [], changed, gone: [] } });
        await settle(1_500);
        expect(notices).toMatchObject([{ title: 'Bo in #general · Garden club', body: 'Hello there, all' }]);
      });

      it('drops a pending batch when Circles stop', async () => {
        const service = await withCircle();
        lastChild!.emit('message', { type: 'chat-update', update: { circleKey: KEY, channel: 'general', added: [fromBo()], changed: [], gone: [] } });
        const stopped = service.stopCircles();
        await settle(1_500);
        await stopped;
        expect(notices).toEqual([]);
      });
    });

    it('broadcasts a channel’s update and hands each message to listeners, past one that throws', async () => {
      const service = await running();
      const added: unknown[] = [];
      const changes: unknown[] = [];
      service.onCircleMessage(() => {
        throw new Error('bad listener');
      });
      service.onCircleMessage((event) => added.push(event.text));
      const stop = service.onCircleMessageChange((change) => changes.push(change.kind));
      const update = {
        circleKey: KEY,
        channel: 'general',
        added: [message('New')],
        changed: [message('Edited', { edited: true })],
        gone: [{ author: ME, id: 'fedcba9876543210' }],
      };
      lastChild!.emit('message', { type: 'chat-update', update });
      expect(broadcasts.at(-1)).toEqual(update);
      expect(added).toEqual(['New']);
      expect(changes).toEqual(['changed', 'gone']);
      stop();
      lastChild!.emit('message', { type: 'chat-update', update });
      expect(changes).toHaveLength(2);
    });
  });
});

describe('configuration point', () => {
  it('getSharedServices() does not read the configuration at import', async () => {
    const { getSharedServices } = await load({ configure: false });
    expect(() => getSharedServices()).not.toThrow();
  });
});
