import { describe, expect, it, vi } from 'vitest';

// The experiment registry globs every experiment. A host file that loaded it at runtime would make
// an experiment's renderer entry import itself, so loading it here fails the test.
vi.mock('../experiments', () => {
  throw new Error('a renderer host file loaded the experiment registry');
});

describe('renderer host API', () => {
  it('loads each host file without the experiment registry', async () => {
    const experiments = await import('../host/experiments');
    const window = await import('../host/window');
    const ipcStore = await import('../host/ipcStore');
    const navigation = await import('../host/navigation');

    expect(typeof experiments.optionalStepOutcome).toBe('function');
    expect(typeof window.onAppWindowShown).toBe('function');
    expect(typeof window.usePaintsOnScreen).toBe('function');
    expect(typeof ipcStore.createIpcStore).toBe('function');
    expect(typeof ipcStore.useIpcStore).toBe('function');
    expect(typeof navigation.openInference).toBe('function');
  });
});
