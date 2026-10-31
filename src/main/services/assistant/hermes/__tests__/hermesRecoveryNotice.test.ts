import { describe, expect, it } from 'vitest';
import { parseRecoveryNotice } from '../hermesRecoveryNotice';

describe('parseRecoveryNotice', () => {
  it('reads the rung from Hermes’s lifecycle status, whichever stop hint follows', () => {
    const text = '⏳ Provider temporarily unavailable — retrying automatically in 31s (cycle 2/5)';
    const rung = { retryInSec: 31, cycle: 2, total: 5 };
    expect(parseRecoveryNotice({ kind: 'lifecycle', text: `${text}; press Esc to stop` })).toEqual(rung);
    expect(parseRecoveryNotice({ kind: 'lifecycle', text })).toEqual(rung);
  });

  it('ignores other statuses, other kinds and missing payloads', () => {
    expect(parseRecoveryNotice({ kind: 'lifecycle', text: 'Compressing context…' })).toBeNull();
    expect(parseRecoveryNotice({ kind: 'status', text: 'retrying automatically in 5s (cycle 1/5)' })).toBeNull();
    expect(parseRecoveryNotice(undefined)).toBeNull();
  });
});
