import { describe, expect, it } from 'vitest';
import { composerBlockFor, composerGate } from '../composerGate';

const none = { connecting: false, restarting: false, credential: false, approval: false, offline: false, private: false };

describe('composerBlockFor', () => {
  it('names the most pressing reason the composer is held', () => {
    expect(composerBlockFor(none)).toBeNull();
    expect(composerBlockFor({ ...none, offline: true, approval: true })).toBe('approval');
    expect(composerBlockFor({ ...none, approval: true, credential: true })).toBe('credential');
    expect(composerBlockFor({ ...none, credential: true, restarting: true })).toBe('restarting');
    expect(composerBlockFor({ ...none, restarting: true, connecting: true })).toBe('connecting');
  });
});

describe('composerGate', () => {
  it('lets a message go out only when nothing holds the composer', () => {
    expect(composerGate(null).canSend).toBe(true);
    for (const block of ['connecting', 'restarting', 'credential', 'approval', 'offline'] as const) {
      expect(composerGate(block).canSend).toBe(false);
    }
  });

  it('locks the input the same way it disables it, connecting included', () => {
    expect(composerGate('connecting')).toMatchObject({ inputLocked: true });
    expect(composerGate('restarting')).toMatchObject({ inputLocked: true });
    expect(composerGate('approval')).toMatchObject({ inputLocked: true });
    // The offline prompt keeps the text editable so it can be sent another way.
    expect(composerGate('offline')).toMatchObject({ inputLocked: false });
    expect(composerGate(null)).toMatchObject({ inputLocked: false });
  });

  it('keeps the Run button for a prompt waiting on an answer, so Stop can deny it', () => {
    expect(composerGate('approval').hideIdleRunButton).toBe(false);
    expect(composerGate('credential').hideIdleRunButton).toBe(false);
    expect(composerGate('connecting').hideIdleRunButton).toBe(true);
    expect(composerGate('restarting').hideIdleRunButton).toBe(true);
    expect(composerGate('offline').hideIdleRunButton).toBe(true);
  });

  it('says why in the placeholder and title', () => {
    expect(composerGate('restarting')).toMatchObject({
      placeholder: 'Wait for the assistant to come back…',
      title: 'Wait for the assistant to come back',
    });
    expect(composerGate(null)).toMatchObject({ placeholder: null, title: 'Press Enter to send' });
  });
});
