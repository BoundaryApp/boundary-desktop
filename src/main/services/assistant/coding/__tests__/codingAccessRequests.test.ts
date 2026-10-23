import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCodingAccessRequest,
  hostPathForAlias,
  isCodingTaskTool,
  needsAccessPath,
} from '../codingAccessRequests';
import { resetCodingRemountQueueForTests, setCodingGrantDepsForTests } from '../codingGrants';
import { addCodingGrantRecord, resetCodingGrantStoreForTests } from '../codingGrantStore';
import {
  resetHermesProjectsStoreForTests,
  upsertStoredHermesProject,
} from '../../hermes/hermesProjectStore';

let home: string;

function folder(...parts: string[]): string {
  const dir = path.join(home, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function useDeps(isLocalStack = false) {
  setCodingGrantDepsForTests({
    isLocalStack: () => isLocalStack,
    ruleOptions: () => ({
      home,
      boundaryDataPaths: [path.join(home, 'boundary')],
      systemFolders: [],
    }),
  });
}

function needsAccess(dir: string): string {
  return JSON.stringify({
    ok: false,
    needs_access: true,
    path: dir,
    roots: ['/Users/ada/workspace'],
    hint: `Path '${dir}' is outside the coding roots. Ask the user to grant access, then have them run: make coding-root-add DIR=${dir}`,
  });
}

function request(resultText: string, toolName = 'mcp_opencode_coding_start_task') {
  return buildCodingAccessRequest({
    toolName,
    resultText,
    args: null,
    sessionId: 's1',
    requestId: 'r1',
    projectId: 'p1',
  });
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coding-access-')));
  resetCodingGrantStoreForTests();
  resetHermesProjectsStoreForTests();
  resetCodingRemountQueueForTests();
  useDeps();
});

afterEach(() => {
  setCodingGrantDepsForTests(null);
  fs.rmSync(home, { recursive: true, force: true });
});

describe('isCodingTaskTool', () => {
  it.each([
    ['coding_start_task', true],
    ['mcp_opencode_coding_start_task', true],
    ['opencode.coding_continue_task', true],
    ['coding_list_roots', false],
    ['coding_get_task_result', false],
    ['write_file', false],
  ])('%s → %s', (name, expected) => {
    expect(isCodingTaskTool(name)).toBe(expected);
  });
});

describe('needsAccessPath', () => {
  it('reads the path from opencode-mcp’s JSON', () => {
    expect(needsAccessPath(needsAccess('/Users/ada/Code/api'), null)).toBe('/Users/ada/Code/api');
  });

  it('recovers the path from a truncated result', () => {
    const truncated = needsAccess('/Users/ada/Code/my "api"').slice(0, 70);
    expect(needsAccessPath(truncated, null)).toBe('/Users/ada/Code/my "api"');
  });

  it('falls back to the call’s directory argument', () => {
    expect(needsAccessPath('{"ok": false, "needs_access": true, "pa', { directory: '/x/y' })).toBe(
      '/x/y'
    );
  });

  it('ignores results that don’t need access', () => {
    expect(needsAccessPath('{"ok": true, "task_id": "t1"}', { directory: '/x' })).toBeNull();
    expect(needsAccessPath('Task started', null)).toBeNull();
    expect(needsAccessPath(null, null)).toBeNull();
  });
});

describe('buildCodingAccessRequest', () => {
  it('describes an existing repo the coding agent can’t reach', () => {
    const repo = folder('Code', 'contact-api');
    folder('Code', 'contact-api', '.git');
    expect(request(needsAccess(repo))).toMatchObject({
      sessionId: 's1',
      requestId: 'r1',
      hostPath: repo,
      name: 'contact-api',
      exists: true,
      isGit: true,
      projectId: 'p1',
      refuseMessage: null,
    });
  });

  it('offers to create a folder that doesn’t exist, judging its parent', () => {
    folder('Code');
    expect(request(needsAccess(path.join(home, 'Code', 'portfolio-landing')))).toMatchObject({
      exists: false,
      refuseMessage: null,
    });
  });

  it('allows a new folder directly in home, but refuses home itself', () => {
    expect(request(needsAccess(path.join(home, 'new-repo')))?.refuseMessage).toBeNull();
    expect(request(needsAccess(home))?.refuseMessage).toMatch(/home folder/);
  });

  it('explains a refused folder instead of offering it', () => {
    const own = folder('boundary', 'stack');
    expect(request(needsAccess(own))?.refuseMessage).toMatch(/Boundary’s own data/);
    expect(request(needsAccess(path.join(home, 'nope', 'x')))?.refuseMessage).toMatch(
      /doesn’t exist/
    );
  });

  it('asks nothing for a folder already covered, other tools, or a developer stack', () => {
    const parent = folder('Code', 'mono');
    addCodingGrantRecord({
      hostPath: parent,
      projectId: 'p1',
      origin: 'add',
      createdByBoundary: false,
    });
    expect(request(needsAccess(path.join(parent, 'web')))).toBeNull();
    expect(request(needsAccess(folder('Code', 'x')), 'write_file')).toBeNull();
    useDeps(true);
    expect(request(needsAccess(folder('Code', 'y')))).toBeNull();
  });

  it('ignores relative paths', () => {
    expect(request(needsAccess('Code/api'))).toBeNull();
  });
});

describe('project folders and aliases (change request 0003 R2)', () => {
  function addProject() {
    const hub = folder('Projects', 'portfolio');
    upsertStoredHermesProject({
      id: 'p2',
      name: 'Portfolio',
      hostPath: hub,
      containerPath: '/opt/projects/portfolio',
      slug: 'portfolio',
      kind: 'host-folder',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    return hub;
  }

  it('maps an /opt/projects path back to the project’s host path', () => {
    const hub = addProject();
    expect(hostPathForAlias('/opt/projects/portfolio')).toBe(hub);
    expect(hostPathForAlias('/opt/projects/portfolio/web')).toBe(path.join(hub, 'web'));
    expect(hostPathForAlias('/opt/projects/other')).toBe('/opt/projects/other');
  });

  it('offers a project’s own folder as that project’s coding switch', () => {
    const hub = addProject();
    expect(request(needsAccess('/opt/projects/portfolio'))).toMatchObject({
      hostPath: hub,
      exists: true,
      projectFolderId: 'p2',
      projectFolderName: 'Portfolio',
    });
    expect(request(needsAccess(hub))?.projectFolderId).toBe('p2');
    expect(request(needsAccess(folder('Code', 'z')))?.projectFolderId).toBeNull();
  });
});
