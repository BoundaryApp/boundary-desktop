import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HermesProjectRecord } from '../../../../../shared/types/hermesChat';

const wrapped = vi.hoisted(() => [] as unknown[]);

vi.mock('../../../storeMemoryCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../storeMemoryCache')>();
  return {
    readStoreFromMemory: <S extends Parameters<typeof actual.readStoreFromMemory>[0]>(store: S) => {
      wrapped.push(store);
      return actual.readStoreFromMemory(store);
    },
  };
});

import {
  getStoredHermesProject,
  listStoredHermesProjects,
  removeStoredHermesProject,
  resetHermesProjectsStoreForTests,
  upsertStoredHermesProject,
} from '../hermesProjectStore';

function project(partial: Partial<HermesProjectRecord> = {}): HermesProjectRecord {
  return {
    id: 'p1',
    name: 'Garden',
    hostPath: '/Users/test/garden',
    containerPath: '/opt/projects/garden',
    slug: 'garden',
    kind: 'host-folder',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('hermesProjectStore', () => {
  beforeEach(() => {
    resetHermesProjectsStoreForTests();
  });

  it('reads the projects store from memory, not from disk on every call (G09-16)', () => {
    expect(wrapped).toHaveLength(1);
  });

  it('hands out copies, so a change that is never saved does not reach the store', () => {
    upsertStoredHermesProject(project());
    const listed = listStoredHermesProjects();
    listed[0].name = 'Changed';
    listed.push(project({ id: 'p2' }));
    const one = getStoredHermesProject('p1')!;
    one.hostPath = '/elsewhere';
    expect(listStoredHermesProjects()).toEqual([project()]);
  });

  it('removes one project by id', () => {
    upsertStoredHermesProject(project());
    upsertStoredHermesProject(project({ id: 'p2', slug: 'notes' }));
    removeStoredHermesProject('p1');
    expect(listStoredHermesProjects().map((row) => row.id)).toEqual(['p2']);
  });
});
