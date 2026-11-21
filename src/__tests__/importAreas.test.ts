import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  alwaysAllowed,
  areaOf,
  entryViolations,
  forbiddenReason,
  hostViolations,
  importGraph,
  importSpecifiers,
  isHostFile,
  leavesArea,
} from '../../scripts/import-areas.mjs';

describe('areaOf', () => {
  it('names experiments, services, UI folders and the shared layers', () => {
    expect(areaOf('src/experiments/demo/main/x.ts')).toBe('exp:demo');
    expect(areaOf('src/main/services/circles/circleOps.ts')).toBe('main:circles');
    expect(areaOf('src/main/services/windows.ts')).toBe('main:services-root');
    expect(areaOf('src/main/ipc.ts')).toBe('main:core');
    expect(areaOf('src/renderer/product/chat/Thread.tsx')).toBe('ui:chat');
    expect(areaOf('src/renderer/product/ProductApp.tsx')).toBe('ui:shell');
    expect(areaOf('src/renderer/components/ui/button.tsx')).toBe('ui:components');
    expect(areaOf('src/renderer/onboarding/Step.tsx')).toBe('renderer:core');
    expect(areaOf('src/index.css')).toBe('renderer:core');
    expect(areaOf('src/preloadIpc.ts')).toBe('preload');
    expect(areaOf('src/shared/types/circles.ts')).toBe('shared');
    expect(areaOf('scripts/x.mjs')).toBeNull();
  });
});

describe('importSpecifiers', () => {
  it('finds static, type, re-export, side-effect and dynamic imports', () => {
    const source = [
      "import { a } from './a';",
      "import type { B } from '../b';",
      "export { c } from './c';",
      "export * from './d';",
      "import './e.css';",
      "const f = await import('./f');",
      'import {',
      '  g,',
      "} from './g';",
    ].join('\n');
    expect(importSpecifiers(source)).toEqual(['./a', '../b', './c', './d', './e.css', './f', './g']);
  });
});

describe('importGraph', () => {
  const tree: Record<string, string> = {
    'src/main/services/circles/net.ts': "import { x } from './ops';\nimport { log } from '../../log';",
    'src/main/services/circles/ops.ts': "import { t } from '../../../shared/types';",
    'src/main/log.ts': "import 'node:fs';",
    'src/shared/types.ts': '',
    'src/renderer/product/chat/A.tsx': "import { missing } from './nowhere';",
  };
  const read = (path: string) => tree[path];
  const isFile = (path: string) => path in tree;

  it('keys cross-area imports by area pair and skips package imports', () => {
    const { edges, unresolved } = importGraph(Object.keys(tree), read, isFile);
    expect([...edges.keys()].sort()).toEqual(['main:circles -> main:core', 'main:circles -> shared']);
    expect(edges.get('main:circles -> main:core')).toEqual([
      { from: 'src/main/services/circles/net.ts', to: 'src/main/log.ts' },
    ]);
    expect(unresolved).toEqual([{ from: 'src/renderer/product/chat/A.tsx', specifier: './nowhere' }]);
  });

  it('finds where a process entry leaves its area, following imports inside it', () => {
    const { imports } = importGraph(Object.keys(tree), read, isFile);
    expect(leavesArea('src/main/services/circles/ops.ts', imports)).toEqual([]);
    expect(leavesArea('src/main/services/circles/net.ts', imports)).toEqual([
      { from: 'src/main/services/circles/net.ts', to: 'src/main/log.ts' },
    ]);
  });
});

describe('edge rules', () => {
  it('forbids imports across the process line and into experiments', () => {
    expect(forbiddenReason('ui:chat -> main:circles')).toMatch(/IPC/);
    expect(forbiddenReason('main:core -> renderer:core')).toMatch(/IPC/);
    expect(forbiddenReason('main:core -> exp:demo')).toMatch(/experiments/);
    expect(forbiddenReason('shared -> main:core')).toMatch(/shared/);
    expect(forbiddenReason('preload -> main:core')).toMatch(/preload/);
    expect(forbiddenReason('exp:demo -> main:circles')).toBeNull();
    expect(forbiddenReason('exp:demo -> exp:other')).toBeNull();
    expect(forbiddenReason('main:circles -> main:addons')).toBeNull();
  });

  it('lets any area import shared code and renderer code import the design system', () => {
    expect(alwaysAllowed('main:circles -> shared')).toBe(true);
    expect(alwaysAllowed('ui:chat -> ui:components')).toBe(true);
    expect(alwaysAllowed('exp:demo -> ui:components')).toBe(true);
    expect(alwaysAllowed('ui:chat -> ui:circles')).toBe(false);
  });
});

describe('host files', () => {
  it('are the files under the main and renderer host folders, and the two preload host files', () => {
    expect(isHostFile('src/main/host/log.ts')).toBe(true);
    expect(isHostFile('src/renderer/host/window.ts')).toBe(true);
    expect(isHostFile('src/preloadExperiments.ts')).toBe(true);
    expect(isHostFile('src/preloadHost.ts')).toBe(true);
    expect(isHostFile('src/main/ipc.ts')).toBe(false);
    expect(isHostFile('src/preloadIpc.ts')).toBe(false);
  });

  const tree: Record<string, string> = {
    'src/main/services/circles/a.ts': "import { log } from '../../host/log';",
    'src/main/host/log.ts':
      "export { persistDebugLog } from '../persistDebugLog';\nexport { x } from '../services/secrets/x';",
    'src/main/host/bad.ts': "export { y } from '../../renderer/y';",
    'src/main/persistDebugLog.ts': '',
    'src/main/services/secrets/x.ts': '',
    'src/renderer/y.ts': '',
    'src/main/services/circles/wrongSide.ts': "import { w } from '../../../renderer/host/window';",
    'src/renderer/host/window.ts': '',
  };
  const read = (path: string) => tree[path];
  const isFile = (path: string) => path in tree;

  it('add no edge when imported, but stay in the file import list', () => {
    const { edges, imports } = importGraph(Object.keys(tree), read, isFile);
    expect(edges.has('main:circles -> main:core')).toBe(false);
    expect(imports.get('src/main/services/circles/a.ts')).toContain('src/main/host/log.ts');
  });

  it('keep process-line edges when imported from the other process', () => {
    const { edges } = importGraph(Object.keys(tree), read, isFile);
    expect(edges.get('main:circles -> renderer:core')).toEqual([
      { from: 'src/main/services/circles/wrongSide.ts', to: 'src/renderer/host/window.ts' },
    ]);
  });

  it('add no edge for their own imports in the same process, but keep process-line edges', () => {
    const { edges } = importGraph(Object.keys(tree), read, isFile);
    expect(edges.has('main:core -> main:secrets')).toBe(false);
    expect(edges.get('main:core -> renderer:core')).toEqual([
      { from: 'src/main/host/bad.ts', to: 'src/renderer/y.ts' },
    ]);
  });

  it('host clients may not import core areas except through host files', () => {
    const imp = {
      from: 'src/main/services/circles/a.ts',
      to: 'src/main/ipc.ts',
    };
    const edges = new Map([
      ['main:circles -> main:core', [imp]],
      ['main:assistant -> main:core', [{ from: 'src/main/services/assistant/b.ts', to: 'src/main/ipc.ts' }]],
    ]);
    const isClient = (area: string) => area === 'main:circles';
    expect(hostViolations(edges, isClient, new Set(['main:core']))).toEqual([imp]);
    expect(hostViolations(edges, () => false, new Set(['main:core']))).toEqual([]);
  });

  it('areas with entries are only imported through them', () => {
    const inside = {
      from: 'src/main/ipc.ts',
      to: 'src/main/services/circles/circleOps.ts',
    };
    const entry = {
      from: 'src/main/ipc.ts',
      to: 'src/main/services/circles/index.ts',
    };
    const edges = new Map([['main:core -> main:circles', [inside, entry]]]);
    const entries = { 'main:circles': ['src/main/services/circles/index.ts'] };
    expect(entryViolations(edges, entries)).toEqual([inside]);
    expect(entryViolations(edges, {})).toEqual([]);
  });

  it('never import the experiment registries at runtime', () => {
    const root = resolve(__dirname, '../..');
    for (const dir of ['src/main/host', 'src/renderer/host']) {
      const abs = join(root, dir);
      if (!existsSync(abs)) continue;
      for (const name of readdirSync(abs)) {
        const source = readFileSync(join(abs, name), 'utf8');
        // Whole statements, so a multi-line `export type { … } from` counts as type-only.
        const runtime = [...source.matchAll(/\b(?:import|export)\s+(type\s)?[^;]*?from\s*'\.\.\/experiments'/g)].filter(
          (match) => match[1] === undefined,
        );
        expect(runtime, `${dir}/${name}`).toEqual([]);
      }
    }
  });
});
