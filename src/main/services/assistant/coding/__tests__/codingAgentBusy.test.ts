import { describe, expect, it, vi } from 'vitest';
import {
  busySessionIds,
  codingAgentBusy,
  isCodingAgentTool,
  sessionTitles,
} from '../codingAgentBusy';

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

describe('a chat turn waiting on a coding task (G10-2)', () => {
  it('matches the tools that start, continue or wait on a task', () => {
    expect(isCodingAgentTool('coding_start_task')).toBe(true);
    expect(isCodingAgentTool('mcp_opencode_coding_continue_task')).toBe(true);
    expect(isCodingAgentTool('coding_wait_for_task')).toBe(true);
    expect(isCodingAgentTool('coding_list_roots')).toBe(false);
    expect(isCodingAgentTool('read_file')).toBe(false);
  });

  it('is busy while a running chat turn’s last tool is a coding tool, even when OpenCode is idle', async () => {
    const fetchFn = vi.fn(async () => json({ s1: { type: 'idle' } }));
    const busy = await codingAgentBusy({
      fetchFn,
      port: 1,
      password: '',
      runningToolNames: () => ['read_file', 'coding_wait_for_task'],
    });
    expect(busy.busy).toBe(true);
    expect(busy.sessions).toEqual(['A chat’s coding task']);
  });

  it('is not busy when no running turn is on a coding tool', async () => {
    const fetchFn = vi.fn(async () => json({}));
    const busy = await codingAgentBusy({
      fetchFn,
      port: 1,
      password: '',
      runningToolNames: () => ['read_file'],
    });
    expect(busy).toEqual({ busy: false, sessions: [] });
  });
});
