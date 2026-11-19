import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
}));

vi.mock('electron', () => ({ dialog: { showOpenDialog: h.showOpenDialog } }));
vi.mock('../../../dialogFolders', () => ({
  dialogStartFolder: () => '/Users/me/Documents',
  rememberDialogPick: vi.fn(),
}));
vi.mock('../../../../ipc', () => ({ handle: vi.fn(), handleResult: vi.fn() }));
vi.mock('../writingVoices', () => ({ createWritingVoice: vi.fn() }));
vi.mock('../writingVoiceStore', () => ({ listWritingVoiceRecords: (): unknown[] => [] }));

import { pickWritingVoiceSamples } from '../writingVoicesIpc';

describe('pickWritingVoiceSamples', () => {
  beforeEach(() => h.showOpenDialog.mockReset());

  it('says when the picker was canceled', async () => {
    h.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await pickWritingVoiceSamples()).toEqual({ canceled: true });
  });

  it('returns the picked files and offers the text types first', async () => {
    h.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/a.md', '/b.txt'] });
    expect(await pickWritingVoiceSamples()).toEqual({ canceled: false, paths: ['/a.md', '/b.txt'] });
    const options = h.showOpenDialog.mock.calls[0][0];
    expect(options.properties).toEqual(['openFile', 'multiSelections']);
    expect(options.title).toBe('Add writing samples');
    expect(options.defaultPath).toBe('/Users/me/Documents');
    expect(options.filters[0]).toEqual({
      name: 'Writing',
      extensions: ['md', 'markdown', 'txt', 'rst', 'text'],
    });
    expect(options.filters[1]).toEqual({ name: 'All files', extensions: ['*'] });
  });
});
