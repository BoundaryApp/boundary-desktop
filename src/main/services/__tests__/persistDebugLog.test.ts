import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getDebugLogPath,
  persistDebugLog,
  readDebugLogTail,
  resetDebugLogPathCache,
  serializeError,
} from '../../persistDebugLog';

describe('persistDebugLog', () => {
  afterEach(() => {
    resetDebugLogPathCache();
  });

  it('writes JSONL under the test log path', () => {
    const logPath = getDebugLogPath();
    expect(logPath).toContain('boundary-desktop-vitest-logs');
    persistDebugLog('test', 'hello', { n: 1 });
    const { path: returned, contents } = readDebugLogTail();
    expect(returned).toBe(logPath);
    expect(contents).toContain('"area":"test"');
    expect(contents).toContain('"message":"hello"');
    expect(fs.existsSync(logPath)).toBe(true);
    expect(path.dirname(logPath)).toBe(path.join(os.tmpdir(), 'boundary-desktop-vitest-logs'));
  });

  it('serializes errno-style errors', () => {
    const err = Object.assign(new Error('spawn podman EACCES'), {
      code: 'EACCES',
      syscall: 'spawn',
      path: '/app/podman',
    });
    const serialized = serializeError(err);
    expect(serialized.code).toBe('EACCES');
    expect(serialized.path).toBe('/app/podman');
    expect(serialized.message).toMatch(/EACCES/);
  });
});
