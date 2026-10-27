import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HermesProjectRecord } from '../../../../../shared/types/hermesChat';
import {
  collectContextExtraRoots,
  listedExtraSourcePaths,
  localTerminalService,
  persistContextExtraRoots,
  upsertHermesContextOverrideBinds,
} from '../hermesContextRoots';
import { writeSourcesYamlToHub } from '../projectSourcesModel';
import { addCodingGrantRecord, resetCodingGrantStoreForTests } from '../../coding/codingGrantStore';

const temps: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function project(hostPath: string, slug: string): HermesProjectRecord {
  return {
    id: slug,
    name: slug,
    hostPath,
    containerPath: `/opt/projects/${slug}`,
    slug,
    kind: 'host-folder',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function writeExtra(hub: string, extraPath: string): void {
  writeSourcesYamlToHub(hub, [
    {
      id: 'project',
      path: '.',
      retrieval: 'files',
      include: ['**/*.md'],
      exclude: [],
    },
    {
      id: 'notes',
      path: extraPath,
      retrieval: 'files',
      include: ['**/*.md'],
      exclude: [],
    },
  ]);
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('hermesContextRoots', () => {
  it('unions env and sources.yaml extras and skips coding-covered paths', () => {
    const envRoot = tmpDir('bd-ctx-env-');
    const hubA = tmpDir('bd-ctx-hub-a-');
    const hubB = tmpDir('bd-ctx-hub-b-');
    const extraA = tmpDir('bd-ctx-extra-a-');
    const extraB = tmpDir('bd-ctx-extra-b-');
    const coding = tmpDir('bd-ctx-code-');
    const underCoding = path.join(coding, 'vault');
    fs.mkdirSync(underCoding);
    writeExtra(hubA, extraA);
    writeExtra(hubB, extraB);
    fs.writeFileSync(
      path.join(envRoot, '.env'),
      `CONTEXT_EXTRA_ROOTS=${extraA}:${underCoding}\nCODING_EXTRA_ROOTS=${coding}\n`,
      'utf8'
    );

    const roots = collectContextExtraRoots({
      projects: [project(hubA, 'job'), project(hubB, 'notes')],
      envRoot,
      home: os.homedir(),
    });
    expect(roots).toEqual([path.resolve(extraA), path.resolve(extraB)].sort());
    expect(roots).not.toContain(path.resolve(underCoding));
  });

  it('leaves out a folder the coding agent was granted (ADR 0028)', () => {
    const envRoot = tmpDir('bd-ctx-grant-');
    const hub = tmpDir('bd-ctx-hub-grant-');
    const extra = tmpDir('bd-ctx-extra-grant-');
    writeExtra(hub, extra);
    fs.writeFileSync(path.join(envRoot, '.env'), '');
    addCodingGrantRecord({ hostPath: extra, projectId: 'job', origin: 'add', createdByBoundary: false });
    try {
      expect(
        collectContextExtraRoots({ projects: [project(hub, 'job')], envRoot, home: os.homedir() })
      ).toEqual([]);
    } finally {
      resetCodingGrantStoreForTests();
    }
  });

  it('drops a root only when asked, even if it is still in env', () => {
    const envRoot = tmpDir('bd-ctx-drop-');
    const hub = tmpDir('bd-ctx-hub-drop-');
    const extra = tmpDir('bd-ctx-extra-drop-');
    writeExtra(hub, extra);
    fs.writeFileSync(
      path.join(envRoot, '.env'),
      `CONTEXT_EXTRA_ROOTS=${extra}\n`,
      'utf8'
    );
    const kept = collectContextExtraRoots({
      projects: [project(hub, 'job')],
      envRoot,
      home: os.homedir(),
    });
    expect(kept).toEqual([path.resolve(extra)]);
    const dropped = collectContextExtraRoots({
      projects: [project(hub, 'job')],
      envRoot,
      drop: [extra],
      home: os.homedir(),
    });
    expect(dropped).toEqual([]);
  });

  it('keeps a path listed by another project in listed extras', () => {
    const hubA = tmpDir('bd-ctx-share-a-');
    const hubB = tmpDir('bd-ctx-share-b-');
    const extra = tmpDir('bd-ctx-share-extra-');
    writeExtra(hubA, extra);
    writeExtra(hubB, extra);
    const listed = listedExtraSourcePaths([
      project(hubA, 'job'),
      project(hubB, 'notes'),
    ]);
    expect(listed.filter((item) => item === path.resolve(extra)).length).toBe(2);
  });

  it('persists CONTEXT_EXTRA_ROOTS without touching HERMES_WRITE_SAFE_ROOT', () => {
    const envRoot = tmpDir('bd-ctx-persist-');
    const extra = tmpDir('bd-ctx-persist-extra-');
    fs.writeFileSync(
      path.join(envRoot, '.env'),
      'HERMES_WRITE_SAFE_ROOT=/opt/data:/opt/projects\nCONTEXT_EXTRA_ROOTS=\n',
      'utf8'
    );
    persistContextExtraRoots([extra], envRoot);
    const text = fs.readFileSync(path.join(envRoot, '.env'), 'utf8');
    expect(text).toContain(`CONTEXT_EXTRA_ROOTS=${extra}`);
    expect(text).toContain('HERMES_WRITE_SAFE_ROOT=/opt/data:/opt/projects');
  });

  it('quotes identity binds with spaces in docker-compose.override.yml', () => {
    const root = tmpDir('bd-ctx-override-');
    const extra = '/Users/you/Documents/Work/Acme/Acme Notes';
    const overridePath = upsertHermesContextOverrideBinds([extra], root);
    const text = fs.readFileSync(overridePath, 'utf8');
    expect(text).toContain(
      '"/Users/you/Documents/Work/Acme/Acme Notes:/Users/you/Documents/Work/Acme/Acme Notes:ro"'
    );
    upsertHermesContextOverrideBinds([extra], root);
    const again = fs.readFileSync(overridePath, 'utf8');
    expect(again.split(extra).length - 1).toBe(2);
  });

  /** The volumes listed under one service of a compose override, in order. */
  function serviceVolumes(text: string, service: string): string[] {
    const lines = text.split('\n');
    const start = lines.indexOf(`  ${service}:`);
    if (start < 0) return [];
    const out: string[] = [];
    let inVolumes = false;
    for (const line of lines.slice(start + 1)) {
      if (/^ {2}\S/.test(line)) break;
      if (/^ {4}\S/.test(line)) inVolumes = line === '    volumes:';
      const bind = /^ {6}- (.*)$/.exec(line);
      if (bind && inVolumes) out.push(bind[1]);
    }
    return out;
  }

  it('binds on hermes-worker, the ssh terminal service, as the stack does', () => {
    const root = tmpDir('bd-ctx-override-');
    fs.writeFileSync(path.join(root, '.env'), 'HERMES_TERMINAL_BACKEND=ssh\n', 'utf8');
    fs.writeFileSync(
      path.join(root, 'docker-compose.override.yml'),
      'services:\n  hermes:\n    environment:\n      - FOO=1\n  hermes-worker:\n    volumes:\n      - /srv/a:/srv/a:ro\n',
      'utf8'
    );
    const extra = '/Users/you/Notes';
    const text = fs.readFileSync(upsertHermesContextOverrideBinds([extra], root), 'utf8');
    expect(serviceVolumes(text, 'hermes-worker')).toEqual([
      '"/Users/you/Notes:/Users/you/Notes:ro"',
      '/srv/a:/srv/a:ro',
    ]);
    expect(serviceVolumes(text, 'hermes')).toEqual([]);
  });

  it('adds the worker bind even when an older Boundary put it on hermes', () => {
    const root = tmpDir('bd-ctx-override-');
    const extra = '/Users/you/Notes';
    fs.writeFileSync(
      path.join(root, 'docker-compose.override.yml'),
      `services:\n  hermes:\n    volumes:\n      - "${extra}:${extra}:ro"\n`,
      'utf8'
    );
    const text = fs.readFileSync(upsertHermesContextOverrideBinds([extra], root), 'utf8');
    expect(serviceVolumes(text, 'hermes-worker')).toEqual([`"${extra}:${extra}:ro"`]);
  });

  it('picks the terminal service from the checkout’s HERMES_TERMINAL_BACKEND', () => {
    const root = tmpDir('bd-ctx-backend-');
    expect(localTerminalService(root)).toBe('hermes-worker');
    fs.writeFileSync(path.join(root, '.env'), 'HERMES_TERMINAL_BACKEND=local\n', 'utf8');
    expect(localTerminalService(root)).toBe('hermes');
    const text = fs.readFileSync(upsertHermesContextOverrideBinds(['/Users/you/Notes'], root), 'utf8');
    expect(serviceVolumes(text, 'hermes')).toEqual(['"/Users/you/Notes:/Users/you/Notes:ro"']);
  });
});
