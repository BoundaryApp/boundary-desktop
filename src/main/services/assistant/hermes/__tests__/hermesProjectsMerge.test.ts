import { describe, expect, it } from 'vitest';
import type { HermesProjectRecord } from '../../../../../shared/types/hermesChat';
import {
  hostPathForLibrarySlug,
  isLibraryContainerPath,
  resolveActiveProjectId,
  slugFromLibraryContainerPath,
  syncProjectsFromGateway,
} from '../hermesProjectsMerge';

const DATA_ROOT = '/Users/me/AssistantData';
const NOW = '2026-09-21T12:00:00.000Z';

function stored(
  partial: Partial<HermesProjectRecord> &
    Pick<HermesProjectRecord, 'id' | 'name' | 'slug' | 'kind'>
): HermesProjectRecord {
  return {
    hostPath:
      partial.kind === 'host-folder'
        ? `/Users/me/Documents/${partial.slug}`
        : hostPathForLibrarySlug(DATA_ROOT, partial.slug),
    containerPath: `/opt/projects/${partial.slug}`,
    hermesProjectId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('hermesProjectsMerge', () => {
  it('recognizes library container paths', () => {
    expect(isLibraryContainerPath('/opt/projects/career')).toBe(true);
    expect(isLibraryContainerPath('/opt/projects')).toBe(false);
    expect(isLibraryContainerPath('/opt/projects/a/b')).toBe(false);
    expect(slugFromLibraryContainerPath('/opt/projects/career')).toBe('career');
  });

  it('upserts disk-discovered library projects and preserves Boundary UUID', () => {
    const existing = stored({
      id: 'boundary-uuid-1',
      name: 'Career',
      slug: 'career',
      kind: 'empty',
      hermesProjectId: 'fs:/opt/projects/career',
    });

    const { projects, activeId } = syncProjectsFromGateway({
      stored: [existing],
      previousActiveId: 'boundary-uuid-1',
      dataRoot: DATA_ROOT,
      now: NOW,
      gateway: {
        activeId: 'p_materialized',
        projects: [
          {
            id: 'p_materialized',
            slug: 'career',
            name: 'Career',
            primaryPath: '/opt/projects/career',
          },
          {
            id: 'fs:/opt/projects/scratch',
            slug: 'scratch',
            name: 'scratch',
            primaryPath: '/opt/projects/scratch',
          },
        ],
      },
    });

    expect(projects).toHaveLength(2);
    const career = projects.find((p) => p.slug === 'career')!;
    expect(career.id).toBe('boundary-uuid-1');
    expect(career.hermesProjectId).toBe('p_materialized');
    expect(career.hostPath).toBe(hostPathForLibrarySlug(DATA_ROOT, 'career'));

    const scratch = projects.find((p) => p.slug === 'scratch')!;
    expect(scratch.kind).toBe('empty');
    expect(scratch.hermesProjectId).toBe('fs:/opt/projects/scratch');
    expect(scratch.hostPath).toBe(hostPathForLibrarySlug(DATA_ROOT, 'scratch'));

    expect(activeId).toBe('boundary-uuid-1');
  });

  it('defaults inference inherit on new gateway rows and preserves existing pins', () => {
    const pinned = stored({
      id: 'boundary-uuid-1',
      name: 'Career',
      slug: 'career',
      kind: 'empty',
      hermesProjectId: 'fs:/opt/projects/career',
      inference: { mode: 'local', modelId: 'qwen3:14b' },
    });

    const { projects } = syncProjectsFromGateway({
      stored: [pinned],
      previousActiveId: 'boundary-uuid-1',
      dataRoot: DATA_ROOT,
      now: NOW,
      gateway: {
        activeId: 'p_materialized',
        projects: [
          {
            id: 'p_materialized',
            slug: 'career',
            name: 'Career',
            primaryPath: '/opt/projects/career',
          },
          {
            id: 'fs:/opt/projects/scratch',
            slug: 'scratch',
            name: 'scratch',
            primaryPath: '/opt/projects/scratch',
          },
        ],
      },
    });

    const career = projects.find((p) => p.slug === 'career')!;
    expect(career.inference).toEqual({ mode: 'local', modelId: 'qwen3:14b' });
    const scratch = projects.find((p) => p.slug === 'scratch')!;
    expect(scratch.inference).toEqual({ mode: 'inherit' });
  });

  it('drops stale empty library rows absent from gateway', () => {
    const stale = stored({
      id: 'gone',
      name: 'Gone',
      slug: 'gone',
      kind: 'empty',
    });
    const keep = stored({
      id: 'keep',
      name: 'Keep',
      slug: 'keep',
      kind: 'empty',
    });

    const { projects } = syncProjectsFromGateway({
      stored: [stale, keep],
      previousActiveId: 'gone',
      dataRoot: DATA_ROOT,
      now: NOW,
      gateway: {
        activeId: 'fs:/opt/projects/keep',
        projects: [
          {
            id: 'fs:/opt/projects/keep',
            slug: 'keep',
            name: 'keep',
            primaryPath: '/opt/projects/keep',
          },
        ],
      },
    });

    expect(projects.map((p) => p.slug)).toEqual(['keep']);
    expect(projects[0].id).toBe('keep');
  });

  it('keeps unmatched host-folder rows when gateway is incomplete', () => {
    const host = stored({
      id: 'host-1',
      name: 'External',
      slug: 'external',
      kind: 'host-folder',
      hostPath: '/Users/me/Documents/External',
    });

    const { projects } = syncProjectsFromGateway({
      stored: [host],
      previousActiveId: 'host-1',
      dataRoot: DATA_ROOT,
      now: NOW,
      gateway: {
        activeId: null,
        projects: [
          {
            id: 'fs:/opt/projects/lib-only',
            slug: 'lib-only',
            name: 'lib-only',
            primaryPath: '/opt/projects/lib-only',
          },
        ],
      },
    });

    expect(projects.map((p) => p.slug).sort()).toEqual(['external', 'lib-only']);
    const external = projects.find((p) => p.slug === 'external')!;
    expect(external.hostPath).toBe('/Users/me/Documents/External');
    expect(external.kind).toBe('host-folder');
  });

  it('preserves out-of-tree hostPath when gateway lists the same slug', () => {
    const host = stored({
      id: 'host-1',
      name: 'Job',
      slug: 'job-search',
      kind: 'host-folder',
      hostPath: '/Users/me/Documents/Job Search',
      hermesProjectId: 'fs:/opt/projects/job-search',
    });

    const { projects } = syncProjectsFromGateway({
      stored: [host],
      previousActiveId: 'host-1',
      dataRoot: DATA_ROOT,
      now: NOW,
      gateway: {
        activeId: 'fs:/opt/projects/job-search',
        projects: [
          {
            id: 'fs:/opt/projects/job-search',
            slug: 'job-search',
            name: 'Job Search',
            primaryPath: '/opt/projects/job-search',
          },
        ],
      },
    });

    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe('host-1');
    expect(projects[0].kind).toBe('host-folder');
    expect(projects[0].hostPath).toBe('/Users/me/Documents/Job Search');
    expect(projects[0].name).toBe('Job Search');
  });

  it('maps gateway active_id when previous active is gone', () => {
    const activeId = resolveActiveProjectId({
      previousActiveId: 'missing',
      gatewayActiveId: 'fs:/opt/projects/a',
      projects: [
        stored({
          id: 'a',
          name: 'A',
          slug: 'a',
          kind: 'empty',
          hermesProjectId: 'fs:/opt/projects/a',
        }),
      ],
    });
    expect(activeId).toBe('a');
  });

  it('preserves explicit no-project across gateway sync', () => {
    const activeId = resolveActiveProjectId({
      previousActiveId: null,
      gatewayActiveId: 'fs:/opt/projects/a',
      projects: [
        stored({
          id: 'a',
          name: 'A',
          slug: 'a',
          kind: 'empty',
          hermesProjectId: 'fs:/opt/projects/a',
        }),
      ],
    });
    expect(activeId).toBeNull();
  });

  it('does not fall back to the first project when previous active is gone', () => {
    const activeId = resolveActiveProjectId({
      previousActiveId: 'missing',
      gatewayActiveId: null,
      projects: [
        stored({
          id: 'a',
          name: 'A',
          slug: 'a',
          kind: 'empty',
          hermesProjectId: 'fs:/opt/projects/a',
        }),
      ],
    });
    expect(activeId).toBeNull();
  });

  it('skips archived gateway projects', () => {
    const { projects } = syncProjectsFromGateway({
      stored: [],
      previousActiveId: null,
      dataRoot: DATA_ROOT,
      now: NOW,
      gateway: {
        activeId: null,
        projects: [
          {
            id: 'fs:/opt/projects/old',
            slug: 'old',
            name: 'old',
            primaryPath: '/opt/projects/old',
            archived: true,
          },
          {
            id: 'fs:/opt/projects/live',
            slug: 'live',
            name: 'live',
            primaryPath: '/opt/projects/live',
          },
        ],
      },
    });
    expect(projects.map((p) => p.slug)).toEqual(['live']);
  });
});
