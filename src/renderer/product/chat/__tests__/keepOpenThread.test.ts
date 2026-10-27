import { describe, expect, it } from 'vitest';
import { keepOpenThread } from '../useChatLists';

const chat = (id: string, projectId: string | null = null) => ({ id, title: id, kind: 'hermes' as const, projectId });

describe('keepOpenThread (ADR 0024)', () => {
  it('keeps the open chat when a refreshed list misses it', () => {
    const prev = [chat('new', 'p1'), chat('a')];
    expect(keepOpenThread([chat('a')], prev, 'new')).toEqual([chat('new', 'p1'), chat('a')]);
  });

  it('takes the refreshed record when the list has the open chat', () => {
    const next = [chat('new', 'p2')];
    expect(keepOpenThread(next, [chat('new', 'p1')], 'new')).toBe(next);
  });

  it('does not add the open chat again when the list has it under its stored id', () => {
    // The first send resolved stored id 'stored' to runtime id 'runtime'; the refresh lists 'stored'.
    const aliases: Record<string, string> = { runtime: 'stored' };
    const sameChat = (a: string, b: string) => (aliases[a] ?? a) === (aliases[b] ?? b);
    const next = [chat('stored', 'p1'), chat('a')];
    expect(keepOpenThread(next, [chat('runtime', 'p1'), chat('a')], 'runtime', sameChat)).toBe(
      next
    );
  });

  it('drops chats that are neither listed nor open', () => {
    expect(keepOpenThread([chat('a')], [chat('gone'), chat('a')], 'a')).toEqual([chat('a')]);
  });
});
