import { describe, expect, it, vi } from 'vitest';
import { ServerPath, type ServerEntry } from '../serverPath';

const u = (id: string, text = id, rowId: number | null = null): ServerEntry => ({
  id,
  role: 'user',
  text,
  rowId,
});
const a = (id: string): ServerEntry => ({ id, role: 'assistant', text: id, rowId: null });

const held = () => new ServerPath([u('u1', 'first', 10), a('a1'), u('u2', 'second', 12), a('a2')]);

describe('ServerPath.plan', () => {
  it('appends when the path extends what Hermes holds', () => {
    expect(held().plan([u('u1'), a('a1'), u('u2'), a('a2'), u('u3')])).toEqual({
      kind: 'append',
    });
    expect(new ServerPath().plan([u('first')])).toEqual({ kind: 'append' });
  });

  it('continues when the path is exactly what Hermes holds and ends on a reply', () => {
    expect(held().plan([u('u1'), a('a1'), u('u2'), a('a2')])).toEqual({ kind: 'continue' });
    // An earlier reply is not the end of what Hermes holds, so it cannot be continued.
    expect(held().plan([u('u1'), a('a1')])).toEqual({ kind: 'diverged' });
  });

  it('rewinds for an edit: same ancestors, new last prompt', () => {
    expect(held().plan([u('u1'), a('a1'), u('u2-edit', 'second!')])).toEqual({
      kind: 'rewind',
      request: { userOrdinal: 1, rowId: 12, expectedText: 'second' },
    });
  });

  it('rewinds for a retry: the path ends on a prompt Hermes already has', () => {
    expect(held().plan([u('u1'), a('a1'), u('u2')])).toEqual({
      kind: 'rewind',
      request: { userOrdinal: 1, rowId: 12, expectedText: 'second' },
    });
  });

  it('rewinds the first prompt by ordinal 0', () => {
    expect(held().plan([u('u1-edit')])).toEqual({
      kind: 'rewind',
      request: { userOrdinal: 0, rowId: 10, expectedText: 'first' },
    });
  });

  it('omits the row id for a turn sent live this session', () => {
    const path = new ServerPath([u('live', 'live prompt'), a('r')]);
    expect(path.plan([u('live')])).toEqual({
      kind: 'rewind',
      request: { userOrdinal: 0, expectedText: 'live prompt' },
    });
  });

  it('refuses to continue an older version Hermes no longer has', () => {
    expect(held().plan([u('u1'), a('a1-old'), u('u9')])).toEqual({ kind: 'diverged' });
  });
});

describe('ServerPath state', () => {
  it('commits a run, appends its reply, and notifies subscribers', () => {
    const path = new ServerPath();
    const listener = vi.fn();
    path.subscribe(listener);
    path.commit([u('u1')]);
    path.append(a('a1'));
    path.append(a('a1'));
    expect(path.messageIds()).toEqual(['u1', 'a1']);
    expect(path.has('a1')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(path.getVersion()).toBe(2);
  });

  it('turns rewinds off once and stays off', () => {
    const path = new ServerPath();
    path.setRewindable(false);
    path.setRewindable(false);
    expect(path.canRewind()).toBe(false);
    expect(path.getVersion()).toBe(1);
  });
});
