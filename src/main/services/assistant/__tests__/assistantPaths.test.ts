import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseAssistantEnvFile,
  resolveAssistantDataRoot,
  resolveAssistantUserContentRoot,
} from '../assistantPaths';

describe('parseAssistantEnvFile', () => {
  it('reads KEY=value, strips quotes, and skips comments', () => {
    const parsed = parseAssistantEnvFile(`
# comment
ASSISTANT_DATA_ROOT="/Users/you/AssistantData"
OTHER='quoted'
EMPTY=
`);
    expect(parsed.ASSISTANT_DATA_ROOT).toBe('/Users/you/AssistantData');
    expect(parsed.OTHER).toBe('quoted');
    expect(parsed.EMPTY).toBe('');
  });
});

describe('resolveAssistantUserContentRoot', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpProject(env?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-assistant-data-'));
    temps.push(dir);
    if (env != null) {
      fs.writeFileSync(path.join(dir, '.env'), env, 'utf8');
    }
    return dir;
  }

  it('falls back to {projectRoot}/data when .env is missing', () => {
    const root = tmpProject();
    expect(resolveAssistantUserContentRoot(root)).toBe(path.join(root, 'data'));
    expect(resolveAssistantDataRoot(root)).toBe(path.join(root, 'data'));
  });

  it('treats ./data as the repo data tree', () => {
    const root = tmpProject('ASSISTANT_DATA_ROOT=./data\n');
    expect(resolveAssistantUserContentRoot(root)).toBe(path.join(root, 'data'));
  });

  it('honors an absolute ASSISTANT_DATA_ROOT', () => {
    const root = tmpProject('ASSISTANT_DATA_ROOT=/Users/you/AssistantData\n');
    expect(resolveAssistantUserContentRoot(root)).toBe(
      path.resolve('/Users/you/AssistantData')
    );
    expect(resolveAssistantDataRoot(root)).toBe(path.join(root, 'data'));
  });

  it('expands ~/AssistantData', () => {
    const root = tmpProject('ASSISTANT_DATA_ROOT=~/AssistantData\n');
    expect(resolveAssistantUserContentRoot(root)).toBe(
      path.join(os.homedir(), 'AssistantData')
    );
  });

  it('resolves a relative root against the project checkout', () => {
    const root = tmpProject('ASSISTANT_DATA_ROOT=../AssistantData\n');
    expect(resolveAssistantUserContentRoot(root)).toBe(
      path.resolve(root, '../AssistantData')
    );
  });

  it('ignores an empty ASSISTANT_DATA_ROOT', () => {
    const root = tmpProject('ASSISTANT_DATA_ROOT=\nFOO=1\n');
    expect(resolveAssistantUserContentRoot(root)).toBe(path.join(root, 'data'));
  });
});
