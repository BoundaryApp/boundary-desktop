import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeGatewaySocket as FakeWS, tick } from './fakeGatewaySocket';

const openWindows = vi.hoisted(() => ({ count: 1 }));
const broadcasts = vi.hoisted(() => [] as Array<{ channel: string; payload: unknown }>);

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () =>
      Array.from({ length: openWindows.count }, () => ({ isDestroyed: () => false })),
  },
}));
vi.mock('../../../windows', () => ({
  broadcast: (channel: string, payload: unknown) => broadcasts.push({ channel, payload }),
}));
vi.mock('../hermesDashboardAuth', () => ({
  mintDashboardWsTicket: vi.fn(async () => ({ ticket: 't', dashboardBaseUrl: 'http://127.0.0.1:9' })),
}));
vi.mock('../../localStackMode', () => ({ stackMode: () => ({ kind: 'managed', root: '/stack' }) }));
const aliases = vi.hoisted(() => new Map<string, string>([['runtime-old', 'stored-1']]));
vi.mock('../hermesAgentStore', () => ({
  getStoredSessionAlias: (id: string) => aliases.get(id) ?? null,
  setStoredSessionAlias: (runtimeId: string, storedId: string) => aliases.set(runtimeId, storedId),
}));

import {
  getHermesGatewaySession,
  HermesGatewaySession,
  resetHermesGatewaySessionForTests,
} from '../hermesGatewaySession';
import { listParkedApprovals, respondToParkedApproval } from '../hermesApprovals';
import { listParkedCredentialRequests, respondToCredentialRequest } from '../hermesCredentialRequests';
import { beginRunningTurn, resetRunningTurnsForTests } from '../hermesRunningTurns';

const realWS = globalThis.WebSocket;
const sessions: HermesGatewaySession[] = [];

function newSession(): HermesGatewaySession {
  const gw = new HermesGatewaySession();
  sessions.push(gw);
  return gw;
}

beforeEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWS;
  FakeWS.reset();
  FakeWS.results = { 'session.list': { sessions: [] }, 'approval.pending': { approvals: [] } };
  broadcasts.length = 0;
  openWindows.count = 1;
  resetRunningTurnsForTests();
  // The redial backoff is full jitter: random 0 makes it redial at once.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  for (const gw of sessions.splice(0)) gw.dispose();
  resetHermesGatewaySessionForTests();
  vi.restoreAllMocks();
  (globalThis as { WebSocket: unknown }).WebSocket = realWS;
});

describe('connection owner (G06-6, new-C-2)', () => {
  it('redials a dropped socket by itself and replays the events a turn missed', async () => {
    const gw = newSession();
    const deltas: string[] = [];
    const completed = vi.fn();
    // Subscribed before any connection exists, as a turn's listeners may be.
    gw.on('message.delta', (event) => deltas.push(String((event.payload as { text?: string }).text)));
    gw.on('message.complete', completed);
    await gw.ensureConnected();
    const first = FakeWS.latest;
    first.serverEvent({ type: 'message.delta', session_id: 's1', seq: 1, payload: { text: 'hi' } });
    await tick();

    FakeWS.results['session.events.since'] = {
      events: [{ type: 'message.delta', session_id: 's1', seq: 2, payload: { text: ' there' } }],
    };
    first.close();
    expect(gw.connectionState).toBe('reconnecting');
    await tick(40);

    expect(FakeWS.all).toHaveLength(2);
    expect(gw.connectionState).toBe('open');
    const second = FakeWS.latest;
    const since = second.sent.find((f) => f.method === 'session.events.since');
    expect(since?.params).toEqual({ session_id: 's1', last_seen: 1 });
    second.serverEvent({ type: 'message.complete', session_id: 's1', seq: 3, payload: {} });
    await tick();

    expect(deltas).toEqual(['hi', ' there']);
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('advertises client.capabilities once per connection', async () => {
    const gw = newSession();
    await gw.ensureConnected();
    await tick();
    expect(FakeWS.latest.methods().filter((m) => m === 'client.capabilities')).toHaveLength(1);
  });

  it('keeps redialing a socket that drops before the gateway is ready', async () => {
    const gw = newSession();
    await gw.ensureConnected();
    // The next socket closes as soon as it opens; the one after it stays up.
    const realOpen = FakeWS.prototype.dispatchEvent;
    let dropNext = true;
    vi.spyOn(FakeWS.prototype, 'dispatchEvent').mockImplementation(function (this: FakeWS, event: Event) {
      const result = realOpen.call(this, event);
      if (event.type === 'open' && dropNext && FakeWS.all.length === 2) {
        dropNext = false;
        this.close();
      }
      return result;
    });
    FakeWS.latest.close();
    await tick(80);
    expect(FakeWS.all).toHaveLength(3);
    expect(gw.connectionState).toBe('open');
  });

  it('tells open listeners about the first socket and each redial, until they unsubscribe', async () => {
    const gw = newSession();
    const opened = vi.fn();
    const unsubscribe = gw.onOpen(opened);
    await gw.ensureConnected();
    expect(opened).toHaveBeenCalledTimes(1);

    FakeWS.latest.close();
    await tick(40);
    expect(gw.connectionState).toBe('open');
    expect(opened).toHaveBeenCalledTimes(2);

    unsubscribe();
    FakeWS.latest.close();
    await tick(40);
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it('opens even when an open listener throws', async () => {
    const gw = newSession();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    gw.onOpen(() => {
      throw new Error('listener broke');
    });
    await gw.ensureConnected();
    expect(gw.connectionState).toBe('open');
  });

  it('does not redial after dispose', async () => {
    const gw = newSession();
    await gw.ensureConnected();
    gw.dispose();
    await tick(40);
    expect(FakeWS.all).toHaveLength(1);
    await expect(gw.ensureConnected()).rejects.toThrow(/disposed/);
  });
});

describe('prompts before the first send (G06-16)', () => {
  it('shows credential requests and approvals from the chat list connection, in every window', async () => {
    const gw = getHermesGatewaySession();
    await gw.listSessions();
    const ws = FakeWS.latest;
    await tick();
    // No approval.pending for an empty session id.
    expect(ws.methods()).not.toContain('approval.pending');

    ws.serverRequest('srv-1', 'secret', { session_id: 's1', env_var: 'FOO_KEY', prompt: 'key?' });
    ws.serverRequest('srv-2', 'approval', { session_id: 's1', request_id: 'a1', command: 'rm x' });
    await tick();

    expect(ws.answerTo('srv-1')).toBeUndefined();
    expect(listParkedCredentialRequests().map((r) => r.rpcRequestId)).toEqual(['srv-1']);
    expect(broadcasts.map((b) => b.channel)).toEqual([
      'hermes-chat:credential-request',
      'hermes-chat:approval',
    ]);
    expect(gw.storedSessionId('runtime-old')).toBe('stored-1');
  });

  it('skips a credential request when no window is open to ask', async () => {
    openWindows.count = 0;
    const gw = getHermesGatewaySession();
    await gw.ensureConnected();
    FakeWS.latest.serverRequest('srv-1', 'secret', { session_id: 's1', env_var: 'FOO_KEY' });
    await tick();
    expect(FakeWS.latest.answerTo('srv-1')).toMatchObject({ result: { value: '' } });
    expect(listParkedCredentialRequests()).toEqual([]);
  });
});

describe('parked requests across a dropped socket (G07-4)', () => {
  it('clears requests the dropped socket asked, so an answer reports failure instead of vanishing', async () => {
    const gw = newSession();
    gw.setCredentialRequestNotifier(() => true);
    await gw.ensureConnected();
    const first = FakeWS.latest;
    first.serverRequest('srv-9', 'secret', { session_id: 's1', env_var: 'FOO_KEY' });
    await tick();
    expect(listParkedCredentialRequests()).toHaveLength(1);

    first.close();
    expect(listParkedCredentialRequests()).toEqual([]);
    const sentBefore = FakeWS.all.map((w) => w.sent.length);
    const res = await respondToCredentialRequest({ rpcRequestId: 'srv-9', value: 'v' });
    expect(res.success).toBe(false);
    expect(FakeWS.all.map((w) => w.sent.length)).toEqual(sentBefore);
  });

  it('asks again for the approvals a drop cleared, and parks each approval once', async () => {
    const gw = newSession();
    const notified = vi.fn();
    gw.setApprovalNotifier(notified);
    await gw.ensureConnected();
    const first = FakeWS.latest;
    first.serverRequest('srv-5', 'approval', { session_id: 's1', request_id: 'a5', command: 'ls' });
    await tick();
    expect(listParkedApprovals().map((a) => a.rpcRequestId)).toEqual(['srv-5']);

    FakeWS.results['approval.pending'] = {
      approvals: [{ request_id: 'a5', session_id: 's1', command: 'ls', choices: ['once', 'deny'] }],
    };
    first.close();
    await tick(40);
    const second = FakeWS.latest;
    expect(second).not.toBe(first);
    expect(second.sent.find((f) => f.method === 'approval.pending')?.params).toEqual({ session_id: 's1' });
    expect(listParkedApprovals().map((a) => a.rpcRequestId)).toEqual(['pending:a5']);

    // Hermes re-sends the live request on the new socket: it replaces the replayed copy.
    second.serverRequest('srv-6', 'approval', { session_id: 's1', request_id: 'a5', command: 'ls' });
    await tick();
    expect(listParkedApprovals().map((a) => a.rpcRequestId)).toEqual(['srv-6']);
  });

  it('asks for approvals of running turns after a reconnect', async () => {
    const gw = newSession();
    await gw.ensureConnected();
    beginRunningTurn('req-1', ['runtime-1'], null);
    FakeWS.latest.close();
    await tick(40);
    expect(FakeWS.latest.sent.find((f) => f.method === 'approval.pending')?.params).toEqual({
      session_id: 'runtime-1',
    });
  });

  it('unparks a request Hermes withdraws with request.cancel', async () => {
    const gw = newSession();
    gw.setCredentialRequestNotifier(() => true);
    await gw.ensureConnected();
    const ws = FakeWS.latest;
    ws.serverRequest('srv-1', 'approval', { session_id: 's1', request_id: 'a1' });
    ws.serverRequest('srv-2', 'secret', { session_id: 's1', env_var: 'K' });
    await tick();
    ws.serverEvent({ type: 'request.cancel', payload: { id: 'srv-1', method: 'approval', reason: 'timeout' } });
    ws.serverEvent({ type: 'request.cancel', payload: { id: 'srv-2', method: 'secret', reason: 'timeout' } });
    await tick();
    expect(listParkedApprovals()).toEqual([]);
    expect(listParkedCredentialRequests()).toEqual([]);
  });
});

describe('answering a replayed approval (G07-6, G07-7)', () => {
  async function parkReplayed(): Promise<FakeWS> {
    const gw = newSession();
    await gw.ensureConnected();
    FakeWS.results['approval.pending'] = {
      approvals: [{ request_id: 'a1', session_id: 's1', choices: ['once', 'deny'] }],
    };
    await gw.replayPendingApprovals(['s1']);
    return FakeWS.latest;
  }

  it('sends nothing for a choice that was not offered, and keeps the approval', async () => {
    const ws = await parkReplayed();
    const res = await respondToParkedApproval({ rpcRequestId: 'pending:a1', choice: 'always' });
    expect(res.success).toBe(false);
    const invalid = await respondToParkedApproval({ rpcRequestId: 'pending:a1', choice: 'yolo' as never });
    expect(invalid.success).toBe(false);
    expect(ws.methods()).not.toContain('approval.respond');
    expect(listParkedApprovals().map((a) => a.rpcRequestId)).toEqual(['pending:a1']);
  });

  it('answers an offered choice with approval.respond and unparks it', async () => {
    const ws = await parkReplayed();
    const res = await respondToParkedApproval({ rpcRequestId: 'pending:a1', choice: 'once' });
    expect(res).toEqual({ success: true });
    expect(ws.sent.find((f) => f.method === 'approval.respond')?.params).toEqual({
      session_id: 's1',
      request_id: 'a1',
      choice: 'once',
    });
    expect(listParkedApprovals()).toEqual([]);
  });

  it('reports failure and keeps the approval when approval.respond fails', async () => {
    await parkReplayed();
    FakeWS.errors['approval.respond'] = { code: 4004, message: 'no such approval' };
    const res = await respondToParkedApproval({ rpcRequestId: 'pending:a1', choice: 'once' });
    expect(res).toEqual({ success: false, error: 'no such approval' });
    expect(listParkedApprovals().map((a) => a.rpcRequestId)).toEqual(['pending:a1']);
  });
});
