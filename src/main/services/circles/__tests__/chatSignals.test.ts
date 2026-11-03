import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => [] as unknown[][]);
const handlers = vi.hoisted(() => new Map<string, (signal: { circleKey: string; fromIdentity: string; payload: unknown }) => void>());
const broadcasts = vi.hoisted(() => [] as unknown[][]);
vi.mock('../circlesService', () => ({
  sendCircleSignal: (...args: unknown[]) => {
    sent.push(args);
    return true;
  },
  onCircleSignal: (topic: string, handler: (signal: { circleKey: string; fromIdentity: string; payload: unknown }) => void) => {
    handlers.set(topic, handler);
    return () => handlers.delete(topic);
  },
}));
vi.mock('../../windows', () => ({ broadcast: (...args: unknown[]) => broadcasts.push(args) }));

import { listenForChatSignals, presenceOf, resetChatSignalsForTests, sendRead, sendTyping } from '../chatSignals';

const KEY = 'cc'.repeat(32);
const MAYA = 'bb'.repeat(32);
const ID = '0123456789abcdef';

describe('chat signals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    broadcasts.length = 0;
    resetChatSignalsForTests();
  });
  afterEach(() => vi.useRealTimers());

  it('sends typing at most once every 3 seconds per channel', () => {
    sendTyping(KEY, 'general', 0);
    sendTyping(KEY, 'general', 2_999);
    sendTyping(KEY, 'garden', 2_999);
    sendTyping(KEY, 'general', 3_000);
    expect(sent).toEqual([
      [KEY, 'chat.typing', { channel: 'general' }],
      [KEY, 'chat.typing', { channel: 'garden' }],
      [KEY, 'chat.typing', { channel: 'general' }],
    ]);
  });

  it('sends a read at once, then at most one a second with the newest', () => {
    const now = Date.now();
    sendRead(KEY, 'general', { author: MAYA, id: ID }, now);
    sendRead(KEY, 'general', { author: MAYA, id: '1111111111111111' }, now + 200);
    sendRead(KEY, 'general', { author: MAYA, id: '2222222222222222' }, now + 400);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(800);
    expect(sent).toEqual([
      [KEY, 'chat.read', { channel: 'general', author: MAYA, id: ID }],
      [KEY, 'chat.read', { channel: 'general', author: MAYA, id: '2222222222222222' }],
    ]);
  });

  it('drops marks that don’t have the right shape', () => {
    expect(presenceOf('chat.typing', { channel: 'general' })).toEqual({ channel: 'general', kind: 'typing' });
    expect(presenceOf('chat.typing', { channel: 'Not a channel' })).toBeNull();
    expect(presenceOf('chat.read', { channel: 'general', author: MAYA, id: ID })).toEqual({
      channel: 'general',
      kind: 'read',
      ref: { author: MAYA, id: ID },
    });
    expect(presenceOf('chat.read', { channel: 'general', author: 'me', id: ID })).toBeNull();
    expect(presenceOf('chat.read', { channel: 'general', author: MAYA, id: 'x' })).toBeNull();
    expect(presenceOf('chat.read', null)).toBeNull();
  });

  it('passes a member’s marks to the renderer with who sent them', () => {
    const stop = listenForChatSignals();
    handlers.get('chat.typing')!({ circleKey: KEY, fromIdentity: MAYA, payload: { channel: 'general' } });
    handlers.get('chat.read')!({ circleKey: KEY, fromIdentity: MAYA, payload: { channel: 'general', author: MAYA } });
    expect(broadcasts).toEqual([
      ['circles:chat-presence', { circleKey: KEY, from: MAYA, channel: 'general', kind: 'typing' }],
    ]);
    stop();
    expect(handlers.size).toBe(0);
  });
});
