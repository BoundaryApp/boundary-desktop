import { describe, expect, it } from 'vitest';
import { hiddenUnread } from '../unreadChip';

const view = { top: 100, bottom: 300 };
const at = (top: number) => ({ top, bottom: top + 34 });

describe('hiddenUnread', () => {
  it('is null when every unread row is in view', () => expect(hiddenUnread([at(120), at(200)], view)).toBeNull());
  it('is null when there are no unread rows', () => expect(hiddenUnread([], view)).toBeNull());
  it('counts rows below and points at the nearest', () =>
    expect(hiddenUnread([at(120), at(320), at(400)], view)).toEqual({ count: 2, direction: 'down', target: 1 }));
  it('points up at the nearest above when none are below', () =>
    expect(hiddenUnread([at(0), at(40), at(150)], view)).toEqual({ count: 2, direction: 'up', target: 1 }));
  it('treats a row more than half out of view as hidden', () =>
    expect(hiddenUnread([at(290)], view)).toEqual({ count: 1, direction: 'down', target: 0 }));
  it('prefers below when rows are hidden both ways', () =>
    expect(hiddenUnread([at(0), at(400)], view)).toEqual({ count: 1, direction: 'down', target: 1 }));
});
