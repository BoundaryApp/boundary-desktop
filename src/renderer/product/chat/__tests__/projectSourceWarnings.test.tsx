import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  HermesProjectRecord,
  HermesProjectSourcesInspect,
  HermesSourceRow,
} from '../../../../shared/types/hermesChat';
import {
  projectSourceWarnings,
  resetKeptWritableForTests,
  useProjectSourceWarnings,
} from '../projectSourceWarnings';

const project = { id: 'p1', name: 'Job Search', hostPath: '/Users/ada/Job Search' } as HermesProjectRecord;
const noCoding = { grants: [] as never[], pending: {}, managed: true };

const hub: HermesSourceRow = {
  id: 'project',
  path: '.',
  hostPath: '/Users/ada/Job Search',
  retrieval: 'files',
  visibility: 'hub',
  isHub: true,
} as HermesSourceRow;

const extra = (visibility: HermesSourceRow['visibility']): HermesSourceRow =>
  ({
    id: 'notes-vault',
    path: '/Users/ada/Notes',
    hostPath: '/Users/ada/Notes',
    retrieval: 'files',
    visibility,
    isHub: false,
  }) as HermesSourceRow;

const inspect = (rows: HermesSourceRow[], stale = false): HermesProjectSourcesInspect => ({
  projectId: 'p1',
  stale,
  sources: [hub, ...rows],
});

describe('projectSourceWarnings', () => {
  afterEach(resetKeptWritableForTests);

  it('names nothing for a hub-only or ready project', () => {
    expect(projectSourceWarnings(project, inspect([]), noCoding, false).top).toBeNull();
    expect(projectSourceWarnings(project, inspect([extra('readonly')]), noCoding, false).top).toBeNull();
  });

  it('puts Not visible first, and it hides Writable and Stale', () => {
    const warnings = projectSourceWarnings(
      project,
      inspect([extra('unmounted'), { ...extra('writable'), id: 'drafts' }], true),
      noCoding,
      false
    );
    expect(warnings.top).toEqual({ kind: 'unmounted', text: 'notes-vault isn’t visible yet.' });
    expect(warnings.showWritable).toBe(false);
    expect(warnings.showStale).toBe(false);
  });

  it('uses the stack’s next-step title when it gives one', () => {
    const withStep: HermesProjectSourcesInspect = {
      ...inspect([extra('readonly')], true),
      nextStep: { tone: 'warn', title: 'Refresh the index.', body: '' },
    };
    expect(projectSourceWarnings(project, withStep, noCoding, false).top).toEqual({
      kind: 'stale',
      text: 'Refresh the index.',
    });
  });

  it('keeps Keep on Writable after the tab closes, until a folder’s visibility changes', () => {
    const writable = inspect([extra('writable')]);
    const first = renderHook(() => useProjectSourceWarnings(project, writable));
    expect(first.result.current.top?.kind).toBe('writable');

    act(() => first.result.current.keepWritable());
    expect(first.result.current.top).toBeNull();
    first.unmount();

    // The inspector closed and opened again: a new reader, same answer.
    const again = renderHook(() => useProjectSourceWarnings(project, writable));
    expect(again.result.current.showWritable).toBe(false);

    const changed = renderHook(() =>
      useProjectSourceWarnings(project, inspect([extra('writable'), { ...extra('readonly'), id: 'more' }]))
    );
    expect(changed.result.current.showWritable).toBe(true);
  });
});
