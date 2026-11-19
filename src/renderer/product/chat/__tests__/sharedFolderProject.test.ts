import { describe, expect, it } from 'vitest';
import type { SharedFolderOnMac } from '../../../../shared/types/sharedFolders';
import { composerSharedHint, sharedFolderAt, sharedFoldersIn, sharedRowView } from '../sharedFolderProject';

const folder = (extra: Partial<SharedFolderOnMac> = {}): SharedFolderOnMac => ({
  key: 'k',
  circle: 'c',
  circleName: 'Studio',
  name: 'Cover art',
  root: '/Users/jordan/Circles/Studio/Cover art',
  role: 'editor',
  defaultRole: 'editor',
  people: 4,
  managers: ['Maya'],
  ended: null,
  ...extra,
});

describe('a shared folder in a project', () => {
  it('matches a project folder by path, ignoring a trailing slash', () => {
    expect(sharedFolderAt('/Users/jordan/Circles/Studio/Cover art/', [folder()])?.key).toBe('k');
    expect(sharedFolderAt('/Users/jordan/Circles/Studio/Cover', [folder()])).toBeNull();
    expect(sharedFoldersIn('/Users/jordan/Circles/Studio', [folder()])).toHaveLength(1);
    expect(sharedFoldersIn('/Users/jordan/Circles/Stu', [folder()])).toHaveLength(0);
  });

  it('says who gets what an editor or their agents write, and whether coding syncs', () => {
    expect(sharedRowView(folder(), true)).toEqual({
      tag: 'Shared · Studio',
      line: 'Everyone in Studio can edit. Anything you or Hermes writes here goes to all 4 people in it. The coding agent’s changes sync too.',
    });
    expect(sharedRowView(folder({ defaultRole: 'reader', role: 'manager', people: 1 }), false).line).toBe(
      'Anything you or Hermes writes here goes to everyone in Studio who adds it. If you allow coding, the coding agent’s changes sync too.'
    );
  });

  it('tells a reader their changes stay here', () => {
    expect(sharedRowView(folder({ role: 'reader', managers: ['Maya', 'Sam'] }), false).line).toBe(
      'Maya and Sam manage it. Hermes can read it; changes made here stay on this Mac.'
    );
  });

  it('says a folder from a Circle this Mac left is no longer shared', () => {
    const view = sharedRowView(folder({ ended: Date.UTC(2026, 10, 9, 12) }), false);
    expect(view.tag).toBe('No longer shared');
    expect(view.line).toMatch(/^You left Studio on .*9.*\. Nothing syncs now; the files stay here\.$/);
  });

  it('hints in the composer only for folders this person can change', () => {
    expect(composerSharedHint([folder()])).toBe('Files written in Cover art reach Studio.');
    expect(composerSharedHint([folder({ role: 'reader' })])).toBeNull();
    expect(composerSharedHint([folder({ ended: 1 })])).toBeNull();
    expect(composerSharedHint([folder(), folder({ name: 'Brief' })])).toBe('Files written in Cover art, Brief reach their Circles.');
  });
});
