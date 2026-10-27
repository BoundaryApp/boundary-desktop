import { describe, expect, it, vi } from 'vitest';

vi.mock('../hermesDashboardAuth', () => ({ mintDashboardWsTicket: vi.fn() }));

import { HermesGatewaySession } from '../hermesGatewaySession';

/** A gateway session whose RPC client is `request`. */
function sessionWith(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
) {
  const session = new HermesGatewaySession();
  const client = { request: vi.fn(request) };
  (session as unknown as { ensureConnected: () => Promise<unknown> }).ensureConnected = async () =>
    client;
  return { session, client };
}

describe('setSessionTitle (ADR 0010 §3)', () => {
  it('titles a session this connection already has live', async () => {
    const { session, client } = sessionWith(async (method) =>
      method === 'session.resume' ? { session_id: 'r1', stored_session_id: 's1', messages: [] } : {}
    );
    await session.resumeSession('s1');
    await session.setSessionTitle('s1', '#pricing');
    expect(client.request).toHaveBeenLastCalledWith('session.title', {
      session_id: 'r1',
      title: '#pricing',
    });
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it('resumes a stored session to title it, and links its runtime id', async () => {
    const { session, client } = sessionWith(async (method) =>
      method === 'session.resume' ? { session_id: 'r9', stored_session_id: 's9' } : {}
    );
    await session.setSessionTitle('s9', '#pricing');
    const calls = client.request.mock.calls.map(([method, params]) => [method, params.session_id]);
    expect(calls).toEqual([
      ['session.resume', 's9'],
      ['session.title', 'r9'],
    ]);
    expect(session.storedSessionId('r9')).toBe('s9');
  });

  it('resumes again when the live id died with a Hermes restart', async () => {
    let resumes = 0;
    const { session, client } = sessionWith(async (method, params) => {
      if (method === 'session.resume') {
        resumes += 1;
        return { session_id: `r${resumes}`, stored_session_id: 's1', messages: [] };
      }
      if (params.session_id === 'r1') throw new Error('session not found');
      return {};
    });
    await session.resumeSession('s1');
    await session.setSessionTitle('s1', '#pricing');
    expect(client.request).toHaveBeenLastCalledWith('session.title', {
      session_id: 'r2',
      title: '#pricing',
    });
  });
});

describe('enableProfileToolsets', () => {
  it('resumes a stored DM so Hermes scopes the change to its profile', async () => {
    const { session, client } = sessionWith(async (method) => {
      if (method === 'session.resume') return { session_id: 'r7', stored_session_id: 'dm-7' };
      return { enabled_toolsets: ['file', 'kanban'] };
    });
    await expect(session.enableProfileToolsets('dm-7', ['kanban'])).resolves.toBe(true);
    const calls = client.request.mock.calls.map(([method, params]) => [method, params.session_id]);
    expect(calls).toEqual([
      ['session.resume', 'dm-7'],
      ['tools.configure', 'r7'],
    ]);
  });

  it('resumes without the transcript it would discard (G06-15)', async () => {
    const { session, client } = sessionWith(async (method) =>
      method === 'session.resume' ? { session_id: 'r7', stored_session_id: 'dm-7' } : { enabled_toolsets: [] }
    );
    await session.enableProfileToolsets('dm-7', ['kanban']);
    await session.resumeSession('dm-7', { omitMessages: true });
    const resumes = client.request.mock.calls.filter(([method]) => method === 'session.resume');
    expect(resumes.map(([, params]) => params.omit_messages)).toEqual([true, true]);
  });

  it('is false when a name did not come back enabled', async () => {
    const { session } = sessionWith(async (method) =>
      method === 'session.resume'
        ? { session_id: 'r7', stored_session_id: 'dm-7' }
        : { enabled_toolsets: ['file'] }
    );
    await expect(session.enableProfileToolsets('dm-7', ['kanban'])).resolves.toBe(false);
  });
});

describe('session id links and agent profiles', () => {
  it('keeps runtime → stored links in the archive, so they resolve after a restart', async () => {
    const saved = new Map<string, string>();
    const archive = { get: (id: string) => saved.get(id) ?? null, set: (a: string, b: string) => void saved.set(a, b) };
    const first = sessionWith(async () => ({ session_id: 'r1', stored_session_id: 's1', messages: [] }));
    first.session.setStoredIdArchive(archive);
    await first.session.resumeSession('s1');
    expect(saved.get('r1')).toBe('s1');

    const restarted = new HermesGatewaySession();
    expect(restarted.storedSessionId('r1')).toBe('r1');
    restarted.setStoredIdArchive(archive);
    expect(restarted.storedSessionId('r1')).toBe('s1');
  });

  it("resumes from the agent's profile when given one", async () => {
    const { session, client } = sessionWith(async () => ({ session_id: 'r2', stored_session_id: 's2' }));
    await session.resumeSession('s2', { profile: 'orchestrator' });
    expect(client.request).toHaveBeenCalledWith(
      'session.resume',
      expect.objectContaining({ session_id: 's2', profile: 'orchestrator' })
    );
  });
});

describe('describeProfile', () => {
  it('names the default profile for the built-in agent, since Hermes refuses no name', async () => {
    const { session, client } = sessionWith(async () => ({ soul: 'x' }));
    await session.describeProfile('');
    await session.describeProfile(' ana ');
    expect(client.request.mock.calls).toEqual([
      ['profiles.describe', { name: 'default' }],
      ['profiles.describe', { name: 'ana' }],
    ]);
  });
});

describe('getMaxTurns', () => {
  const withConfig = (config: unknown) => sessionWith(async () => ({ config }));

  it("reads the profile's whole config, since Hermes has no getter for max_turns alone", async () => {
    const { session, client } = withConfig({ agent: { max_turns: 40 } });
    await expect(session.getMaxTurns('ana')).resolves.toBe(40);
    expect(client.request).toHaveBeenCalledWith('config.get', { key: 'full', profile: 'ana' });
  });

  it('falls back to a top-level max_turns, as Hermes does', async () => {
    await expect(withConfig({ max_turns: '30' }).session.getMaxTurns()).resolves.toBe(30);
  });

  it('answers null when unset or unlimited', async () => {
    for (const config of [{}, { agent: { max_turns: 0 } }, { agent: { max_turns: 'unlimited' } }, null]) {
      await expect(withConfig(config).session.getMaxTurns()).resolves.toBeNull();
    }
  });
});
