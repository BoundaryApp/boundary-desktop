import { describe, expect, it } from 'vitest';
import {
  describeRewindError,
  planRewind,
  REWIND_STALE_MESSAGE,
  REWIND_UNSUPPORTED_MESSAGE,
} from '../hermesRewind';
import type { HermesChatMessage } from '../../../../../shared/types/hermesChat';

const history: HermesChatMessage[] = [
  { role: 'user', content: 'first prompt', rowId: 10 },
  { role: 'assistant', content: 'first reply', rowId: 11 },
  { role: 'user', content: 'second  prompt\n', rowId: 12 },
  { role: 'assistant', content: 'second reply', rowId: 13 },
];

describe('planRewind', () => {
  it('cuts at the row id the renderer names when its text still matches', () => {
    expect(
      planRewind(history, { userOrdinal: 1, rowId: 12, expectedText: 'second prompt' })
    ).toEqual({ kind: 'truncate', rowId: 12, confirmEmpty: false });
  });

  it('resolves a live turn by ordinal and confirms an empty cut for the first turn', () => {
    expect(planRewind(history, { userOrdinal: 0, expectedText: 'first prompt' })).toEqual({
      kind: 'truncate',
      rowId: 10,
      confirmEmpty: true,
    });
  });

  it('appends when the turn never reached Hermes', () => {
    expect(planRewind(history, { userOrdinal: 2, expectedText: 'third' })).toEqual({
      kind: 'append',
    });
  });

  it('refuses when the text at the target no longer matches', () => {
    expect(planRewind(history, { userOrdinal: 1, expectedText: 'something else' })).toEqual({
      kind: 'refuse',
      code: 'rewind-stale',
      error: REWIND_STALE_MESSAGE,
    });
  });

  it('refuses when the named row id is gone', () => {
    expect(planRewind(history, { userOrdinal: 1, rowId: 99, expectedText: 'second prompt' }))
      .toMatchObject({ kind: 'refuse', code: 'rewind-stale' });
  });

  it('refuses when Hermes gives no row ids', () => {
    expect(
      planRewind([{ role: 'user', content: 'old gateway' }], {
        userOrdinal: 0,
        expectedText: 'old gateway',
      })
    ).toEqual({ kind: 'refuse', code: 'rewind-unsupported', error: REWIND_UNSUPPORTED_MESSAGE });
  });

  it('tolerates a prefix Hermes adds to the stored text', () => {
    expect(
      planRewind([{ role: 'user', content: '[ctx] first prompt', rowId: 5 }], {
        userOrdinal: 0,
        expectedText: 'first prompt',
      })
    ).toMatchObject({ kind: 'truncate', rowId: 5 });
  });
});

describe('describeRewindError', () => {
  it('maps gateway refusal codes to readable text', () => {
    expect(describeRewindError({ code: 4018, message: 'x' })).toBe(REWIND_STALE_MESSAGE);
    expect(describeRewindError({ code: 4030 })).toBe(REWIND_STALE_MESSAGE);
    expect(describeRewindError({ code: 4029 })).toBe(REWIND_UNSUPPORTED_MESSAGE);
    expect(describeRewindError(new Error('socket closed'))).toBe('socket closed');
  });
});
