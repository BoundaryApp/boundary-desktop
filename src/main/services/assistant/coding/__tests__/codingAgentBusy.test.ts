import { describe, expect, it, vi } from 'vitest';
import { busySessionIds, codingAgentBusy, sessionTitles } from '../codingAgentBusy';

function json(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

describe('busySessionIds', () => {
  it('returns ids whose status is not idle', () => {
    expect(
      busySessionIds({
        ses_b: { type: 'busy' },
        ses_a: { type: 'retry', attempt: 2 },
        ses_c: { type: 'idle' },
      })
    ).toEqual(['ses_a', 'ses_b']);
  });

  it('ignores shapes it does not recognise', () => {
    expect(busySessionIds(null)).toEqual([]);
    expect(busySessionIds([{ id: 'x' }])).toEqual([]);
    expect(busySessionIds({ ses: { other: true } })).toEqual([]);
  });
});

describe('sessionTitles', () => {
  it('maps busy ids to titles, falling back to the id', () => {
    expect(
      sessionTitles(
        [
          { id: 'a', title: 'hermes-delegate-1234abcd' },
          { id: 'b', title: '  ' },
          { id: 'c', title: 'idle one' },
        ],
        ['a', 'b']
      )
    ).toEqual(['hermes-delegate-1234abcd', 'b']);
  });
});

describe('codingAgentBusy', () => {
  it('asks OpenCode with basic auth and reports busy sessions by title', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.endsWith('/session/status')
        ? json({ s1: { type: 'busy' } })
        : json([{ id: 's1', title: 'Fix header layout' }])
    );
    const busy = await codingAgentBusy({ fetchFn, port: 14096, username: 'opencode', password: 'pw' });
    expect(busy).toEqual({ busy: true, sessions: ['Fix header layout'] });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:14096/session/status');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('opencode:pw').toString('base64')}`
    );
  });

  it('is not busy when every session is idle', async () => {
    const fetchFn = vi.fn(async () => json({ s1: { type: 'idle' } }));
    expect(await codingAgentBusy({ fetchFn, port: 1, password: '' })).toEqual({
      busy: false,
      sessions: [],
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('treats an unreachable or unauthorised coding agent as not busy', async () => {
    const refused = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect((await codingAgentBusy({ fetchFn: refused, port: 1, password: '' })).busy).toBe(false);
    const unauthorised = vi.fn(async () => json({}, false));
    expect((await codingAgentBusy({ fetchFn: unauthorised, port: 1, password: '' })).busy).toBe(
      false
    );
  });
});
