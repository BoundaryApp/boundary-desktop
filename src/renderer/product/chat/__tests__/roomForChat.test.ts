import { describe, expect, it } from 'vitest';
import type { ChannelRecord } from '../../../../shared/types/hermesChat';
import { roomForChat } from '../useRoomSheets';

const room: ChannelRecord = {
  id: 'ch1',
  slug: 'research',
  title: 'research',
  sessionId: 's-room',
  memberSlugs: [],
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
};

describe('roomForChat', () => {
  it('finds the room by the thread’s channelId', () => {
    expect(roomForChat({ channelId: 'ch1' }, 'anything', [room], () => false)).toBe(room);
  });

  it('finds a room open under its runtime id when the thread carries no channelId', () => {
    const sameChat = (a: string | null | undefined, b: string | null | undefined) =>
      (a === 's-room' && b === 'runtime-9') || (a === 'runtime-9' && b === 's-room') || a === b;
    expect(roomForChat(null, 'runtime-9', [room], sameChat)).toBe(room);
  });

  it('finds nothing when no chat is open', () => {
    expect(roomForChat(null, null, [room], () => true)).toBeNull();
  });
});
