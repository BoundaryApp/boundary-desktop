import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const pickSavePath = vi.fn();

vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0' } }));
vi.mock('../../../ipc', () => ({
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
  handleResult: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
}));
vi.mock('../../saveDialog', () => ({ pickSavePath: (...args: unknown[]) => pickSavePath(...args) }));
let logContents = '';
vi.mock('../../../persistDebugLog', () => ({ readDebugLogTail: () => ({ path: '', contents: logContents }) }));
const storedSecretValues = vi.fn(async (): Promise<string[]> => []);
vi.mock('../storedSecrets', () => ({ storedSecretValues: () => storedSecretValues() }));

const { registerBugReportHandlers, reportEnvironment } = await import('../ipcHandlers');
registerBugReportHandlers();

const event = { sender: {} };

describe('bug-report:save', () => {
  beforeEach(() => pickSavePath.mockReset());

  it('writes the title and text where the user picks', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'report-save-')), 'boundary-report.md');
    pickSavePath.mockResolvedValue(file);
    const result = await handlers.get('bug-report:save')?.(event, { title: 'Search fails', body: 'Body' });
    expect(result).toEqual({ success: true, saved: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('# Search fails\n\nBody\n');
    expect(pickSavePath).toHaveBeenCalledWith(event.sender, expect.objectContaining({ defaultPath: 'boundary-report.md' }));
  });

  it('writes nothing when the user cancels', async () => {
    pickSavePath.mockResolvedValue(null);
    expect(await handlers.get('bug-report:save')?.(event, { title: 'T', body: 'B' })).toEqual({
      success: true,
      saved: false,
    });
  });
});

describe('bug-report:collect', () => {
  beforeEach(() => {
    logContents = '';
    storedSecretValues.mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  it('answers with app details even when the log is empty', async () => {
    const context = (await handlers.get('bug-report:collect')?.(event)) as { errors: unknown[]; environment: unknown };
    expect(context.errors).toEqual([]);
    expect(context.environment).toEqual(reportEnvironment());
  });

  it('masks a stored secret that no pattern rule recognises', async () => {
    // Short, all letters, no known prefix: the pattern rules leave it alone.
    const secret = 'plainwordsecret';
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-11-13T10:00:00.000Z'));
    logContents = JSON.stringify({
      ts: '2026-11-13T09:59:00.000Z',
      area: 'calendar',
      message: 'sync failed',
      data: { name: 'CalendarSyncError', message: `login refused for ${secret}` },
    });
    storedSecretValues.mockResolvedValue([secret]);

    const context = (await handlers.get('bug-report:collect')?.(event)) as {
      errors: Array<{ message: string }>;
      redactions: Array<{ kind: string }>;
    };
    expect(context.errors[0].message).toBe('sync failed: login refused for [key]');
    expect(JSON.stringify(context)).not.toContain(secret);
    expect(context.redactions).toContainEqual(expect.objectContaining({ kind: 'key' }));
  });
});
