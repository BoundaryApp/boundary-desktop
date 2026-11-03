import { describe, expect, it } from 'vitest';
import { chatChannels } from '../circleChat';
import type { CircleRecordEntry } from '../networkMessages';

const record = (key: string, value: unknown, extra: Partial<CircleRecordEntry> = {}): CircleRecordEntry => ({
  circleKey: 'k',
  app: 'chat',
  scope: 'circle',
  identity: null,
  key,
  value,
  confirmed: true,
  ...extra,
});

describe('chatChannels', () => {
  it('always has General, which a record can rename', () => {
    expect([...chatChannels([])]).toEqual([['general', 'General']]);
    expect(chatChannels([record('general', { name: ' Lobby ' })]).get('general')).toBe('Lobby');
  });

  it('adds a channel per Circle record of the chat app, showing its id when the name won’t do', () => {
    const channels = chatChannels([
      record('garden', { name: 'Garden' }),
      record('odd', { name: 42 }),
      record('long', { name: 'x'.repeat(81) }),
      record('general', null),
      record('mine', { name: 'Mine' }, { scope: 'member', identity: 'aa' }),
      record('other', { name: 'Other' }, { app: 'notes' }),
    ]);
    expect([...channels]).toEqual([
      ['general', 'General'],
      ['garden', 'Garden'],
      ['odd', 'odd'],
      ['long', 'long'],
    ]);
  });
});
