import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, autoUpdater: {}, dialog: {}, BrowserWindow: {} }));
vi.mock('electron-store', () => ({ default: class {} }));
vi.mock('../../assistant/coding/codingGrants', () => ({}));
vi.mock('../../assistant/hermes/hermesKanban', () => ({}));
vi.mock('../../assistant/hermes/hermesRunningTurns', () => ({}));

import { recordDataVersion } from '../ipcHandlers';

function run(stored: unknown, version: string) {
  let value = stored;
  recordDataVersion(
    {
      get: () => value,
      set: (_key, next) => {
        value = next;
      },
    },
    version
  );
  return value;
}

describe('recordDataVersion', () => {
  it('records the first version and moves forward', () => {
    expect(run(undefined, '0.0.1-rc.9')).toBe('0.0.1-rc.9');
    expect(run('0.0.1-rc.9', '0.0.1')).toBe('0.0.1');
  });

  it('keeps a newer version when an older app opens the data', () => {
    expect(run('0.0.2', '0.0.1')).toBe('0.0.2');
  });
});
