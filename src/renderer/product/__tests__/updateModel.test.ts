import { describe, expect, it } from 'vitest';
import type { UpdateSnapshot } from '../../../shared/types/updates';
import { describeUpdate } from '../updateModel';

const base: UpdateSnapshot = {
  currentVersion: '0.0.1-rc.9',
  channel: 'beta',
  checksEnabled: true,
  blocked: 'none',
  phase: 'available',
  version: '0.0.1-rc.10',
  summary: ['Chats remember their project.'],
  size: 324000000,
  downloadPercent: null,
  stackChanges: false,
  checking: false,
  lastCheckedAt: null,
  error: null,
  keyRequired: false,
  showCard: true,
  waiting: [],
  restartIn: null,
  restarting: false,
  updated: null,
  showUpdated: false,
};

const updated = { version: '0.0.1-rc.9', summary: ['Search answers sooner.'] };
const task = { id: 'task:1', kind: 'task' as const, title: 'Summarize invoices', detail: 'Board task', finished: false };

describe('describeUpdate', () => {
  it('offers the download with its size', () => {
    const description = describeUpdate(base);
    expect(description).toMatchObject({
      stage: 'available',
      title: 'Boundary 0.0.1-rc.10 is available',
      body: '324 MB download.',
      detail: '324 MB',
      lines: base.summary,
    });
    expect(description.actions.map((action) => action.id)).toEqual(['download', 'skip']);
  });

  it('puts a rejected key ahead of an offer', () => {
    expect(describeUpdate({ ...base, error: 'key' }).stage).toBe('key-rejected');
  });

  it('puts a counting-down restart ahead of waiting and of the finished-update confirmation', () => {
    const state = { ...base, phase: 'ready' as const, restartIn: 12, waiting: [task], updated, showUpdated: true };
    expect(describeUpdate(state, { confirmUpdated: true }).stage).toBe('last-call');
    expect(describeUpdate({ ...state, restartIn: null }, { confirmUpdated: true }).stage).toBe('waiting');
  });

  it('confirms the finished update only when asked to', () => {
    const state = { ...base, updated, showUpdated: true };
    expect(describeUpdate(state, { confirmUpdated: true })).toMatchObject({
      stage: 'updated',
      title: 'Boundary is now 0.0.1-rc.9',
      lines: updated.summary,
    });
    expect(describeUpdate(state).stage).toBe('available');
  });

  it('offers a retry and a skip after a failed download', () => {
    const description = describeUpdate({ ...base, error: 'download' });
    expect(description.stage).toBe('failed');
    expect(description.actions.map((action) => action.label)).toEqual(['Try again', 'Skip this version']);
  });

  it('reads as up to date after skipping a version whose download failed', () => {
    const description = describeUpdate({ ...base, phase: 'idle', version: null, error: 'download' });
    expect(description.stage).toBe('current');
  });

  it('adds the stack note to a ready update that moves the stack', () => {
    expect(describeUpdate({ ...base, phase: 'ready', stackChanges: true }).note).toBe(
      'The next start takes a few minutes while your tools update.'
    );
  });

  it('turns Check now off while a check runs', () => {
    const description = describeUpdate({ ...base, phase: 'idle', version: null, checking: true });
    expect(description.title).toBe('Checking…');
    expect(description.actions).toEqual([{ id: 'check', label: 'Check now', disabled: true }]);
  });
});
