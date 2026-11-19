import { ipcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({
  readProjectFileForCheck: vi.fn(),
  pickProjectFileForCheck: vi.fn(),
}));
vi.mock('../../hermes/writingCheckFiles', () => files);
vi.mock('electron-store', () => ({ default: class {} }));

import { registerWritingCheckHandlers } from '../writingCheckIpc';

type Registered = (event: unknown, ...args: unknown[]) => unknown;

function registered(channel: string): Registered {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error(`nothing registered for ${channel}`);
  return call[1] as Registered;
}

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear();
  files.readProjectFileForCheck.mockReset();
  files.pickProjectFileForCheck.mockReset();
});

describe('registerWritingCheckHandlers', () => {
  it('serves the file read and pick on writing-check channels', async () => {
    registerWritingCheckHandlers();
    const result = { success: true, text: 'Dear Acme', name: 'acme.md', modifiedAt: '' };
    files.readProjectFileForCheck.mockResolvedValue(result);
    files.pickProjectFileForCheck.mockResolvedValue({ success: false, canceled: true });

    const payload = { projectId: 'p1', relativePath: 'letters/acme.md' };
    await expect(registered('writing-check:file-read')({}, payload)).resolves.toEqual(result);
    expect(files.readProjectFileForCheck).toHaveBeenCalledWith(payload);

    const sender = { id: 7 };
    const pick = registered('writing-check:file-pick');
    await expect(pick({ sender }, { projectId: 'p1' })).resolves.toEqual({
      success: false,
      canceled: true,
    });
    expect(files.pickProjectFileForCheck).toHaveBeenCalledWith(sender, { projectId: 'p1' });
  });
});
