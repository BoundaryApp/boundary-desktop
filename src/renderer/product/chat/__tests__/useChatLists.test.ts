import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { ChatScreenSnapshot } from '../chatScreenCache';

const listThreads = vi.fn();
const listAgents = vi.fn();
const listChannels = vi.fn();
const listMentions = vi.fn();
const markMentionsSeen = vi.fn();
const sessionsChanged = new Set<() => void>();

stubElectronAPI({
  hermesChat: {
    listThreads: (...args: unknown[]) => listThreads(...args),
    listMentions: (...args: unknown[]) => listMentions(...args),
    markMentionsSeen: (...args: unknown[]) => markMentionsSeen(...args),
    onSessionsChanged: (cb: () => void) => {
      sessionsChanged.add(cb);
      return () => sessionsChanged.delete(cb);
    },
  },
  agents: { list: (...args: unknown[]) => listAgents(...args) },
  channels: { list: (...args: unknown[]) => listChannels(...args) },
});

import { useChatIds } from '../useChatIds';
import { CHAT_LIST_FALLBACK_POLL_MS, useChatLists } from '../useChatLists';

const chat = (id: string) => ({
  id,
  title: id,
  agentSlug: 'assistant',
  kind: 'hermes' as const,
  updatedAt: '2026-10-01T00:00:00.000Z',
});

function renderLists(cached: ChatScreenSnapshot | null = null) {
  return renderHook(() => {
    const ids = useChatIds(cached);
    return { ids, lists: useChatLists(cached, ids) };
  });
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useChatLists', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionsChanged.clear();
    listThreads.mockReset().mockResolvedValue({ success: true, threads: [chat('t1')] });
    listAgents.mockReset().mockResolvedValue({ success: true, agents: [], standingDmByAgent: {} });
    listChannels
      .mockReset()
      .mockResolvedValue({ success: true, channels: [], lastOpened: null });
    listMentions.mockReset().mockResolvedValue({ success: true, mentions: [] });
    markMentionsSeen.mockReset().mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the rail seeded from the snapshot when the first chat list fails', async () => {
    listThreads.mockResolvedValue({ success: false, error: 'gateway down' });
    const cached: ChatScreenSnapshot = {
      threads: [chat('t-cached')],
      activeThreadId: 't-cached',
      idAliases: {},
      agents: [],
      standingDmByAgent: {},
      channels: [],
      mentions: [],
      projects: [],
      activeProjectId: null,
    };
    const { result } = renderLists(cached);
    await flush();
    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(result.current.lists.threadError).toBe('gateway down');
    expect(result.current.lists.threads.map((t) => t.id)).toEqual(['t-cached']);
  });

  it('lands once on mount and leaves where it landed to later refreshes', async () => {
    const { result } = renderLists();
    await flush();
    expect(result.current.ids.activeThreadId).toBe('t1');

    act(() => result.current.ids.setActiveThreadId(null));
    act(() => {
      for (const cb of sessionsChanged) cb();
    });
    await flush(500);
    expect(listThreads).toHaveBeenCalledTimes(2);
    expect(result.current.ids.activeThreadId).toBeNull();
  });

  it('re-lists everything after sessions-changed, not on a 12 s timer', async () => {
    renderLists();
    await flush();
    const calls = () => [
      listThreads.mock.calls.length,
      listAgents.mock.calls.length,
      listChannels.mock.calls.length,
      listMentions.mock.calls.length,
    ];
    expect(calls()).toEqual([1, 1, 1, 1]);

    await flush(12_000);
    expect(calls()).toEqual([1, 1, 1, 1]);

    act(() => {
      for (const cb of sessionsChanged) cb();
    });
    await flush(500);
    expect(calls()).toEqual([2, 2, 2, 2]);
  });

  it('keeps a slow fallback poll of the chat list only', async () => {
    renderLists();
    await flush();
    await flush(CHAT_LIST_FALLBACK_POLL_MS);
    expect(listThreads).toHaveBeenCalledTimes(2);
    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(listChannels).toHaveBeenCalledTimes(1);
    expect(listMentions).toHaveBeenCalledTimes(1);
  });

  it('clears the rail count when Mentions is opened, even if main cannot store that', async () => {
    vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
    listMentions.mockResolvedValue({
      success: true,
      mentions: [
        {
          id: 'post-1:helper',
          channelId: 'c1',
          channelSlug: 'general',
          sessionId: 's1',
          agentSlug: 'helper',
          text: 'Made-up question',
          at: '2026-10-01T00:00:00.000Z',
          status: 'replied',
          reply: { text: 'Made-up answer', at: '2026-10-01T00:01:00.000Z' },
          unseen: true,
        },
      ],
    });
    markMentionsSeen.mockRejectedValue(new Error('store write failed'));
    const { result } = renderLists();
    await flush();
    expect(result.current.lists.mentionsUnseen).toBe(1);

    await act(() => result.current.lists.markMentionsSeen());
    expect(markMentionsSeen).toHaveBeenCalledTimes(1);
    expect(result.current.lists.mentionsUnseen).toBe(0);
  });
});
