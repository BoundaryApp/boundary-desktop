import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  buildHermesProjectsOverlayYaml,
  containerPathForSlug,
  ensureProjectMountPoints,
  slugifyProjectName,
  uniqueProjectSlug,
} from '../hermesProjectsOverlay';
import type { HermesProjectRecord } from '../../../../../shared/types/hermesChat';
import { mapUsageSnapshot } from '../hermesUsageMap';

function project(
  partial: Partial<HermesProjectRecord> & Pick<HermesProjectRecord, 'id' | 'name' | 'slug'>
): HermesProjectRecord {
  return {
    hostPath: `/Users/me/${partial.slug}`,
    containerPath: containerPathForSlug(partial.slug),
    kind: 'host-folder',
    hermesProjectId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('hermesProjectsOverlay', () => {
  it('slugifies project names', () => {
    expect(slugifyProjectName('Job Search')).toBe('job-search');
    expect(slugifyProjectName('  Notes!!  ')).toBe('notes');
  });

  it('ensures unique slugs', () => {
    const existing = [project({ id: '1', name: 'Job', slug: 'job-search' })];
    expect(uniqueProjectSlug('Job Search', existing)).toBe('job-search-2');
  });

  it('adds host-folder binds only, merging into the other mounts by container path', () => {
    const yaml = buildHermesProjectsOverlayYaml([
      project({
        id: '1',
        name: 'Job Search',
        slug: 'job-search',
        hostPath: '/Users/me/Documents/Job Search',
      }),
      project({
        id: '2',
        name: 'Scratch',
        slug: 'scratch',
        kind: 'empty',
        hostPath: '/tmp/data/projects/scratch',
      }),
    ]);
    expect(yaml).toContain('"/Users/me/Documents/Job Search:/opt/projects/job-search"');
    expect(yaml).not.toContain('/tmp/data/projects/scratch');
    expect(yaml).toContain('hermes-webui:');
    // No restated base list: upstream's patch and data mounts stay in charge.
    expect(yaml).not.toContain('!override');
    expect(yaml).not.toContain('/opt/data');
    expect(yaml).not.toContain('BOUNDARY_HERMES_PATCHES_DIR');
  });

  const jobSearch = () =>
    project({
      id: '1',
      name: 'Job Search',
      slug: 'job-search',
      hostPath: '/Users/me/Documents/Job Search',
    });
  type Overlay = { services: Record<string, { volumes: string[] }> };

  it('with the ssh worker, gives it the writable binds and context roots', () => {
    const doc = yaml.load(
      buildHermesProjectsOverlayYaml([jobSearch()], ['/Users/ada/My Notes'], 'ssh')
    ) as Overlay;
    expect(doc.services['hermes-worker'].volumes).toEqual([
      '/Users/me/Documents/Job Search:/opt/projects/job-search',
      '/Users/ada/My Notes:/Users/ada/My Notes:ro',
    ]);
    // hermes reads project folders in-process for projects.list / projects.tree only.
    expect(doc.services.hermes.volumes).toEqual([
      '/Users/me/Documents/Job Search:/opt/projects/job-search:ro',
    ]);
    expect(doc.services['hermes-webui'].volumes).toEqual([
      '/Users/me/Documents/Job Search:/opt/projects/job-search',
    ]);
  });

  it('with the local backend, puts it all on hermes', () => {
    const doc = yaml.load(
      buildHermesProjectsOverlayYaml([jobSearch()], ['/Users/ada/My Notes'], 'local')
    ) as Overlay;
    expect(doc.services.hermes.volumes).toEqual([
      '/Users/me/Documents/Job Search:/opt/projects/job-search',
      '/Users/ada/My Notes:/Users/ada/My Notes:ro',
    ]);
    expect(doc.services['hermes-worker']).toBeUndefined();
    expect(yaml.load(buildHermesProjectsOverlayYaml([]))).toEqual({ services: {} });
  });

  it('creates mount points under data/projects for host-folder projects only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mounts-'));
    ensureProjectMountPoints(
      [
        jobSearch(),
        project({ id: '2', name: 'Scratch', slug: 'scratch', kind: 'empty' }),
        project({ id: '3', name: 'Odd', slug: 'odd', containerPath: '/opt/projects/../escape' }),
      ],
      dir
    );
    expect(fs.readdirSync(dir)).toEqual(['job-search']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a valid empty overlay with no host-folder projects', () => {
    const yaml = buildHermesProjectsOverlayYaml([]);
    expect(yaml).toContain('services: {}');
    expect(yaml).not.toContain('volumes:');
  });

  it('adds identity :ro extra binds on hermes only and omits home and root', () => {
    const yaml = buildHermesProjectsOverlayYaml(
      [
        project({
          id: '1',
          name: 'Job Search',
          slug: 'job-search',
          hostPath: '/Users/me/Documents/Job Search',
        }),
      ],
      ['/Users/ada/Notes/this-project', '/', os.homedir()]
    );
    expect(yaml).toContain(
      '"/Users/ada/Notes/this-project:/Users/ada/Notes/this-project:ro"'
    );
    expect(yaml).not.toMatch(
      /hermes-webui:[\s\S]*\/Users\/ada\/Notes\/this-project/
    );
    expect(yaml).not.toContain('"/Users/ada/Notes/this-project":/opt/projects');
    expect(yaml).toContain('"/Users/me/Documents/Job Search:/opt/projects/job-search"');
    expect(yaml).not.toContain(`"${os.homedir()}":${os.homedir()}:ro`);
    expect(yaml).not.toContain('"/":/:ro');
  });

  it('quotes identity binds when the extra path has spaces', () => {
    const yaml = buildHermesProjectsOverlayYaml(
      [],
      ['/Users/you/Documents/Work/Acme/Acme Notes']
    );
    expect(yaml).toContain(
      '"/Users/you/Documents/Work/Acme/Acme Notes:/Users/you/Documents/Work/Acme/Acme Notes:ro"'
    );
    expect(yaml).not.toContain(
      '"/Users/you/Documents/Work/Acme/Acme Notes":/Users/you/Documents/Work/Acme/Acme Notes:ro'
    );
  });

  it('keeps extra binds when rewriting from host-folder projects alone', () => {
    const extras = ['/Users/ada/Notes/this-project'];
    const first = buildHermesProjectsOverlayYaml(
      [
        project({
          id: '1',
          name: 'Job Search',
          slug: 'job-search',
          hostPath: '/Users/me/Documents/Job Search',
        }),
      ],
      extras
    );
    const rewritten = buildHermesProjectsOverlayYaml(
      [
        project({
          id: '1',
          name: 'Job Search',
          slug: 'job-search',
          hostPath: '/Users/me/Documents/Job Search',
        }),
      ],
      extras
    );
    expect(rewritten).toContain(
      '"/Users/ada/Notes/this-project:/Users/ada/Notes/this-project:ro"'
    );
    expect(rewritten).toContain('"/Users/me/Documents/Job Search:/opt/projects/job-search"');
    expect(first).toContain(
      '"/Users/ada/Notes/this-project:/Users/ada/Notes/this-project:ro"'
    );
  });

  describe('coding mounts (ADR 0028)', () => {
    const coding = {
      roots: ['/Users/me/Code/design tokens', '/Users/me/Documents/Job Search'],
      shadows: ['/Users/me/Code/design tokens/.env'],
      shadowSource: '/Users/me/Library/Application Support/Boundary/assistant-stack/coding/empty-env',
    };
    const expected = [
      '/Users/me/Code/design tokens:/Users/me/Code/design tokens',
      '/Users/me/Documents/Job Search:/Users/me/Documents/Job Search',
      '/Users/me/Library/Application Support/Boundary/assistant-stack/coding/empty-env:/Users/me/Code/design tokens/.env:ro',
    ];

    it('with the ssh worker, binds coding roots read-write on opencode and the worker only', () => {
      const doc = yaml.load(
        buildHermesProjectsOverlayYaml([jobSearch()], [], 'ssh', coding)
      ) as Overlay;
      expect(doc.services.opencode.volumes).toEqual(expected);
      expect(doc.services['hermes-worker'].volumes).toEqual([
        '/Users/me/Documents/Job Search:/opt/projects/job-search',
        ...expected,
      ]);
      // A granted project folder keeps its /opt/projects bind and gains its host path.
      expect(doc.services.hermes.volumes).toEqual([
        '/Users/me/Documents/Job Search:/opt/projects/job-search:ro',
      ]);
      expect(doc.services['hermes-webui'].volumes).toEqual([
        '/Users/me/Documents/Job Search:/opt/projects/job-search',
      ]);
    });

    it('with the local backend, binds them on hermes and opencode', () => {
      const doc = yaml.load(
        buildHermesProjectsOverlayYaml([], [], 'local', coding)
      ) as Overlay;
      expect(doc.services.hermes.volumes).toEqual(expected);
      expect(doc.services.opencode.volumes).toEqual(expected);
      expect(doc.services['hermes-worker']).toBeUndefined();
    });

    it('adds no opencode block without grants', () => {
      const doc = yaml.load(
        buildHermesProjectsOverlayYaml([jobSearch()], [], 'ssh', {
          roots: [],
          shadows: [],
          shadowSource: '/x',
        })
      ) as Overlay;
      expect(doc.services.opencode).toBeUndefined();
    });
  });
});

describe('mapUsageSnapshot', () => {
  it('maps context fields and leaves percent null when max missing', () => {
    const snap = mapUsageSnapshot({
      context_used: 100,
      avg_tps: 12.5,
      prompt: 80,
      completion: 20,
    });
    expect(snap.contextUsed).toBe(100);
    expect(snap.contextMax).toBeNull();
    expect(snap.contextPercent).toBeNull();
    expect(snap.avgTps).toBe(12.5);
  });

  it('preserves context_max and percent when present', () => {
    const snap = mapUsageSnapshot({
      context_used: 18823,
      context_max: 32000,
      context_percent: 58.8,
      context_estimated: true,
    });
    expect(snap.contextMax).toBe(32000);
    expect(snap.contextPercent).toBe(58.8);
    expect(snap.contextEstimated).toBe(true);
  });
});
