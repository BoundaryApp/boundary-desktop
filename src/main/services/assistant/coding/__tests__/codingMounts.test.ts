import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HermesProjectRecord } from '../../../../../shared/types/hermesChat';
import {
  resetHermesProjectsStoreForTests,
  upsertStoredHermesProject,
} from '../../hermes/hermesProjectStore';
import { codingPathAliases } from '../codingGrantRules';
import { addCodingGrantRecord, resetCodingGrantStoreForTests } from '../codingGrantStore';
import { codingStackEnv, persistCodingStackEnv } from '../codingMounts';

function project(partial: Partial<HermesProjectRecord>): HermesProjectRecord {
  return {
    id: 'p1',
    name: 'Portfolio',
    hostPath: '/Users/ada/Projects/portfolio',
    containerPath: '/opt/projects/portfolio',
    slug: 'portfolio',
    kind: 'host-folder',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('codingPathAliases', () => {
  it('pairs each host-folder project’s /opt/projects path with its host path, sorted', () => {
    expect(
      codingPathAliases([
        project({ id: 'b', containerPath: '/opt/projects/zeta', hostPath: '/srv/zeta/' }),
        project({ id: 'a' }),
        project({ id: 'c', kind: 'empty', containerPath: '/opt/projects/notes', hostPath: '/x' }),
      ])
    ).toBe('/opt/projects/portfolio=/Users/ada/Projects/portfolio;/opt/projects/zeta=/srv/zeta');
  });

  it('leaves out paths the format can’t express', () => {
    expect(
      codingPathAliases([
        project({ hostPath: '/Users/ada/a;b' }),
        project({ id: 'x', hostPath: '/Users/ada/a=b' }),
        project({ id: 'y', hostPath: "/Users/ada/it's" }),
      ])
    ).toBe('');
  });

  it('keeps spaces', () => {
    expect(codingPathAliases([project({ hostPath: '/Users/ada/My Site' })])).toBe(
      '/opt/projects/portfolio=/Users/ada/My Site'
    );
  });
});

describe('codingStackEnv', () => {
  beforeEach(() => {
    resetCodingGrantStoreForTests();
    resetHermesProjectsStoreForTests();
  });

  it('sets the roots, both "app will ask" flags and the aliases', () => {
    upsertStoredHermesProject(project({ codingEnabled: true }));
    addCodingGrantRecord({
      hostPath: '/Users/ada/Code/api',
      projectId: 'p1',
      origin: 'add',
      createdByBoundary: false,
    });
    expect(codingStackEnv()).toEqual({
      CODING_EXTRA_ROOTS: ':/Users/ada/Code/api:/Users/ada/Projects/portfolio',
      CODING_ROOTS_APP_MANAGED: '1',
      CONTEXT_ROOTS_APP_MANAGED: '1',
      CODING_PATH_ALIASES: '/opt/projects/portfolio=/Users/ada/Projects/portfolio',
    });
  });
});

describe('persistCodingStackEnv', () => {
  let envRoot: string;
  beforeEach(() => {
    resetCodingGrantStoreForTests();
    resetHermesProjectsStoreForTests();
    envRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-env-root-'));
  });
  afterEach(() => fs.rmSync(envRoot, { recursive: true, force: true }));

  it('writes the variables to .env, quoting values with spaces, and keeps other lines', () => {
    fs.writeFileSync(path.join(envRoot, '.env'), 'OPENCODE_SERVER_PASSWORD=pw\n');
    upsertStoredHermesProject(project({ hostPath: '/Users/ada/My Site' }));
    persistCodingStackEnv(['/Users/ada/Code/api'], envRoot);
    const env = fs.readFileSync(path.join(envRoot, '.env'), 'utf8');
    expect(env).toContain('OPENCODE_SERVER_PASSWORD=pw');
    expect(env).toContain('CODING_EXTRA_ROOTS=:/Users/ada/Code/api');
    expect(env).toContain('CODING_ROOTS_APP_MANAGED=1');
    expect(env).toContain('CONTEXT_ROOTS_APP_MANAGED=1');
    expect(env).toContain("CODING_PATH_ALIASES='/opt/projects/portfolio=/Users/ada/My Site'");
  });
});
