import { describe, expect, it, vi } from 'vitest';
import {
  getWebuiSessionHistory,
  listWebuiSessions,
  mergeHermesThreadLists,
  webuiOnlySessionIds,
} from '../hermesWebuiSessions';

vi.mock('../hermesEndpoints', () => ({
  resolveHermesStackEndpoints: () => ({
    dashboardBaseUrl: 'http://127.0.0.1:8642',
    apiBaseUrl: 'http://127.0.0.1:8643/v1',
    healthUrl: 'http://127.0.0.1:8643/health',
    webuiBaseUrl: 'http://127.0.0.1:8787',
  }),
}));

describe('mergeHermesThreadLists', () => {
  it('prefers gateway metadata on id conflicts', () => {
    const merged = mergeHermesThreadLists(
      [
        {
          id: 'shared',
          title: 'From gateway',
          source: 'boundary',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      [
        {
          id: 'shared',
          title: 'From WebUI',
          source: 'webui',
          updatedAt: '2026-01-03T00:00:00.000Z',
        },
        {
          id: 'web-only',
          title: 'Only WebUI',
          source: 'webui',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]
    );
    expect(merged.map((t) => t.id)).toEqual(['shared', 'web-only']);
    expect(merged[0]).toMatchObject({
      id: 'shared',
      title: 'From gateway',
      source: 'boundary',
    });
    expect(merged[1].source).toBe('webui');
  });

  it("keeps WebUI's workspace when the gateway row has no cwd", () => {
    const merged = mergeHermesThreadLists(
      [
        { id: 'bare', title: 'G', source: 'webui' },
        { id: 'own', title: 'G', source: 'webui', cwd: '/opt/projects/own' },
      ],
      [
        { id: 'bare', title: 'W', source: 'webui', cwd: '/opt/projects/job' },
        { id: 'own', title: 'W', source: 'webui', cwd: '/opt/projects/job' },
      ]
    );
    expect(Object.fromEntries(merged.map((t) => [t.id, t.cwd]))).toEqual({
      bare: '/opt/projects/job',
      own: '/opt/projects/own',
    });
  });

  it('sorts by updatedAt descending', () => {
    const merged = mergeHermesThreadLists(
      [{ id: 'a', title: 'A', updatedAt: '2026-01-01T00:00:00.000Z' }],
      [{ id: 'b', title: 'B', updatedAt: '2026-02-01T00:00:00.000Z' }]
    );
    expect(merged.map((t) => t.id)).toEqual(['b', 'a']);
  });
});

describe('webuiOnlySessionIds', () => {
  it('returns ids present only in webui', () => {
    const only = webuiOnlySessionIds(
      [{ id: 'g1', title: 'G' }],
      [
        { id: 'g1', title: 'G', source: 'webui' },
        { id: 'w1', title: 'W', source: 'webui' },
      ]
    );
    expect([...only]).toEqual(['w1']);
  });
});

describe('listWebuiSessions', () => {
  it('parses array and wrapped session payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sessions: [
          {
            session_id: 'w1',
            title: 'Hello',
            updated_at: 1_700_000_000,
          },
        ],
      }),
    });
    const threads = await listWebuiSessions(fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/sessions',
      expect.objectContaining({ method: 'GET' })
    );
    expect(threads).toEqual([
      {
        id: 'w1',
        title: 'Hello',
        source: 'webui',
        updatedAt: new Date(1_700_000_000 * 1000).toISOString(),
      },
    ]);
  });

  it("reads the workspace picked in WebUI as the chat's cwd", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sessions: [
          { session_id: 'w1', title: 'In a project', workspace: '/opt/projects/job ' },
          { session_id: 'w2', title: 'No workspace', workspace: '' },
        ],
      }),
    });
    const threads = await listWebuiSessions(fetchImpl as never);
    expect(threads.map((t) => [t.id, t.cwd])).toEqual([
      ['w1', '/opt/projects/job'],
      ['w2', undefined],
    ]);
    expect('cwd' in threads[1]).toBe(false);
  });

  it('answers null, not an empty list, when WebUI does not answer', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
    expect(await listWebuiSessions(fetchImpl as never)).toBeNull();
  });
});

describe('getWebuiSessionHistory', () => {
  it('maps nested session messages', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        session: {
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', text: 'hello' },
          ],
        },
      }),
    });
    const messages = await getWebuiSessionHistory('w1', fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/session?session_id=w1',
      expect.objectContaining({ method: 'GET' })
    );
    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('keeps a stored time in seconds, ms or ISO form', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        session: {
          messages: [
            { role: 'user', content: 'a', timestamp: 1767225600 },
            { role: 'assistant', content: 'b', created_at: 1767225660000 },
            { role: 'user', content: 'c', createdAt: '2026-01-01T00:02:00.000Z' },
            { role: 'assistant', content: 'd', timestamp: 'soon' },
          ],
        },
      }),
    });
    const messages = await getWebuiSessionHistory('w1', fetchImpl as never);
    expect(messages).toEqual([
      { role: 'user', content: 'a', timestamp: 1767225600 },
      { role: 'assistant', content: 'b', timestamp: 1767225660 },
      { role: 'user', content: 'c', timestamp: 1767225720 },
      { role: 'assistant', content: 'd' },
    ]);
  });
});
