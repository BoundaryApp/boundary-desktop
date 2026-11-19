import { describe, expect, it } from 'vitest';
import { changedLines, changeVerb, folderState, quorumLine } from '../circle/sharedFolderView';
import { added, change, circle, offered } from './sharedFolderFixtures';

describe('folder state and quorum', () => {
  it('puts a conflict before waiting, and waiting only when too few managers are online', () => {
    expect(folderState(added({ conflicts: ['a (conflict, Sam).md'], unconfirmed: 3 }), circle)).toEqual({ kind: 'conflict', copies: ['a (conflict, Sam).md'] });
    expect(folderState(added({ unconfirmed: 3 }), circle)).toEqual({ kind: 'waiting', changes: 3, managers: ['Sam'] });
    const samOnline = { ...circle, members: circle.members.map((member) => ({ ...member, online: true })) };
    expect(folderState(added({ unconfirmed: 3 }), samOnline)).toEqual({ kind: 'up-to-date', unshared: 1 });
  });

  it('names what a change did and which lines differ', () => {
    expect(changeVerb(change())).toBe('added');
    expect(changeVerb(change({ version: 3 }))).toBe('changed');
    expect(changeVerb(change({ deleted: true, version: 4 }))).toBe('deleted');
    expect(changeVerb(change({ conflictOf: 'a.md' }))).toBe('conflict');
    expect(changedLines('a\nb\nc', 'a\nB')).toEqual([[false, true, true], [false, true]]);
  });

  it('shows one state at a time, downloading first', () => {
    expect(folderState(offered)).toEqual({ kind: 'not-added' });
    expect(folderState({ ...offered, local: { root: '/x', summary: null } })).toEqual({ kind: 'opening' });
    expect(folderState(added({ role: 'reader', mirror: { root: '/x', unshared: [], waiting: 3 } }))).toEqual({ kind: 'downloading', waiting: 3 });
    expect(folderState(added({ role: 'reader' }))).toEqual({ kind: 'read-only', unshared: 1 });
    expect(folderState(added())).toEqual({ kind: 'up-to-date', unshared: 1 });
  });

  it('names a majority of managers', () => {
    expect(quorumLine(['you'])).toBe('Changes confirm when you are online.');
    expect(quorumLine(['you', 'Sam'])).toBe('2 managers: changes confirm when both have seen them.');
    expect(quorumLine(['you', 'Sam', 'Maya'])).toBe('3 managers: changes confirm when 2 of 3 have seen them.');
    expect(quorumLine(['a', 'b', 'c', 'd'])).toBe('4 managers: changes confirm when 3 of 4 have seen them.');
  });
});
