import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDebugLogPath, persistDebugLog } from '../persistDebugLog';

describe('persistDebugLog', () => {
  beforeEach(() => {
    fs.rmSync(getDebugLogPath(), { force: true });
  });

  it('keeps the file bounded within one session', () => {
    const payload = 'x'.repeat(1_000);
    // 6 MB of lines from one process, as a runaway error loop would write.
    for (let i = 0; i < 6_000; i += 1) persistDebugLog('test', 'line', { payload });
    expect(fs.statSync(getDebugLogPath()).size).toBeLessThanOrEqual(2.5 * 1024 * 1024);
  });
});
