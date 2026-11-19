import { describe, expect, it } from 'vitest';
import { accountState, parseIndexerLog } from '../emailIndexLog';

const pass = (at: string, extra: Record<string, unknown> = {}): string =>
  `${at} ${JSON.stringify({
    in_scope: 52,
    added: 3,
    updated: 0,
    removed: 0,
    missing_files: 0,
    unreadable: 0,
    accounts_missing: [],
    mailboxes_missing: 0,
    compacted: false,
    ...extra,
  })}`;

describe('parseIndexerLog', () => {
  it('parses the latest pass line and its failed map', () => {
    const log = parseIndexerLog(
      [
        pass('2026-11-11T14:00:00.1Z', { in_scope: 10 }),
        pass('2026-11-11T14:05:01.123456789Z', { failed: { work: 4 }, error: '4' }),
      ].join('\n'),
    );
    expect(log.lastPass).toEqual({
      at: '2026-11-11T14:05:01.123456789Z',
      inScope: 52,
      failed: { work: 4 },
    });
  });

  it('ignores a pass line that is only an error code', () => {
    const log = parseIndexerLog(
      [pass('2026-11-11T14:00:00Z'), '2026-11-11T14:05:00Z {"error":"2"}'].join('\n'),
    );
    expect(log.lastPass?.at).toBe('2026-11-11T14:00:00Z');
  });

  it('keeps the latest skip reason per slug, and drops it once a later pass has no skip for that slug', () => {
    const skips = parseIndexerLog(
      [
        '2026-11-11T14:00:00Z email-indexer: home: no mailboxes chosen yet',
        '2026-11-11T14:01:00Z email-indexer: home: still no mailboxes',
      ].join('\n'),
    );
    expect(skips.skipped).toEqual({
      home: { at: '2026-11-11T14:01:00Z', reason: 'still no mailboxes' },
    });
    const home = '2026-11-11T14:00:00Z email-indexer: home: no mailboxes chosen yet';
    const afterOne = parseIndexerLog([home, pass('2026-11-11T14:05:00Z')].join('\n'));
    expect(Object.keys(afterOne.skipped)).toEqual(['home']);
    const afterTwo = parseIndexerLog(
      [home, pass('2026-11-11T14:05:00Z'), pass('2026-11-11T14:20:00Z')].join('\n'),
    );
    expect(afterTwo.skipped).toEqual({});
  });

  it('a skip printed just before a pass line belongs to that pass', () => {
    const log = parseIndexerLog(
      [
        pass('2026-11-11T14:00:00Z'),
        '2026-11-11T14:14:59Z email-indexer: home: no mailboxes chosen yet',
        pass('2026-11-11T14:15:00Z'),
      ].join('\n'),
    );
    expect(log.skipped.home?.reason).toBe('no mailboxes chosen yet');
    expect(log.lastPass?.at).toBe('2026-11-11T14:15:00Z');
  });

  it('ignores lines that are neither JSON nor email-indexer lines', () => {
    const log = parseIndexerLog(
      [
        '2026-11-11T14:00:00Z mail-index: work: login to imap.example.com failed',
        '2026-11-11T14:00:01Z not json at all',
        'no timestamp {"in_scope": 1}',
        '',
      ].join('\n'),
    );
    expect(log).toEqual({ lastPass: null, skipped: {}, passEnds: [], latestAt: '2026-11-11T14:00:01Z' });
  });

  it('records every pass end, error-only ones too, and the latest line’s time', () => {
    const log = parseIndexerLog(
      [
        pass('2026-11-11T14:00:00Z'),
        '2026-11-11T14:05:00Z {"error":"5"}',
        '2026-11-11T14:06:00Z email-indexer: home: no mailboxes chosen yet',
      ].join('\n'),
    );
    expect(log.passEnds).toEqual(['2026-11-11T14:00:00Z', '2026-11-11T14:05:00Z']);
    expect(log.latestAt).toBe('2026-11-11T14:06:00Z');
    expect(parseIndexerLog('').latestAt).toBeNull();
  });
});

describe('accountState', () => {
  const host = 'imap.example.com';

  it('reads Waiting with no pass line, then Indexed after the first pass', () => {
    expect(accountState('work', host, null, parseIndexerLog(''))).toEqual({
      state: 'waiting',
      detail: null,
      indexedAt: null,
    });
    const log = parseIndexerLog(pass('2026-11-11T14:00:00Z'));
    expect(accountState('work', host, null, log)).toEqual({
      state: 'indexed',
      detail: null,
      indexedAt: '2026-11-11T14:00:00Z',
    });
  });

  it('ignores a failed code from a pass that ended before the last change', () => {
    const log = parseIndexerLog(pass('2026-11-11T14:00:00Z', { failed: { work: 4 } }));
    expect(accountState('work', host, { at: '2026-11-11T14:02:00Z', startedAfter: '' }, log).state).toBe('waiting');
    // Changed while the indexer was stopped: the first pass after the change started after it.
    expect(accountState('work', host, { at: '2026-11-11T13:59:00Z', startedAfter: '' }, log).state).toBe('login_refused');
  });

  it('maps failed 4, failed 5 and a skip', () => {
    const log = parseIndexerLog(
      [
        '2026-11-11T14:00:00Z email-indexer: home: no mailboxes chosen yet',
        pass('2026-11-11T13:59:00Z', { failed: { work: 4, other: 5 } }),
        '2026-11-11T14:00:00Z email-indexer: home: no mailboxes chosen yet',
      ].join('\n'),
    );
    expect(accountState('work', host, null, log)).toMatchObject({ state: 'login_refused' });
    const unreachable = accountState('other', host, null, log);
    expect(unreachable.state).toBe('unreachable');
    expect(unreachable.detail).toContain(host);
    expect(accountState('home', host, null, log)).toEqual({
      state: 'left_out',
      detail: 'no mailboxes chosen yet',
      indexedAt: null,
    });
  });
});

describe('accountState after a change', () => {
  const host = 'imap.example.com';
  const skip = '2026-11-11T14:00:00Z email-indexer: work: no mailboxes chosen yet';

  it('skip, then change, then no new pass line: waiting, not left out', () => {
    const pending = parseIndexerLog([pass('2026-11-11T13:00:00Z'), skip].join('\n'));
    expect(accountState('work', host, { at: '2026-11-11T14:01:00Z', startedAfter: null }, pending).state).toBe('waiting');
    const ended = parseIndexerLog([skip, pass('2026-11-11T14:05:00Z')].join('\n'));
    expect(accountState('work', host, { at: '2026-11-11T14:10:00Z', startedAfter: '' }, ended).state).toBe('waiting');
  });

  it('skip, then change, then a pass line that ended before the change: waiting', () => {
    const log = parseIndexerLog([skip, pass('2026-11-11T14:05:00Z')].join('\n'));
    expect(accountState('work', host, { at: '2026-11-11T14:06:00Z', startedAfter: '' }, log)).toEqual({
      state: 'waiting',
      detail: null,
      indexedAt: null,
    });
  });

  it('a skip printed after the change still leaves the account out', () => {
    const log = parseIndexerLog([pass('2026-11-11T13:00:00Z'), skip].join('\n'));
    expect(accountState('work', host, { at: '2026-11-11T13:30:00Z', startedAfter: null }, log)).toMatchObject({
      state: 'left_out',
      detail: 'no mailboxes chosen yet',
    });
  });

  it('a pass running at the change never makes it indexed; the pass after a restart Boundary ran does', () => {
    const change = '2026-11-11T14:02:00Z';
    // The pass that began at 14:00 ends during the restart, before the mark read after it.
    const running = pass('2026-11-11T14:02:05Z');
    const marked = { at: change, startedAfter: '2026-11-11T14:02:05Z' };
    expect(accountState('work', host, marked, parseIndexerLog(running)).state).toBe('waiting');
    const after = parseIndexerLog([running, pass('2026-11-11T14:03:00Z')].join('\n'));
    expect(accountState('work', host, marked, after)).toEqual({
      state: 'indexed',
      detail: null,
      indexedAt: '2026-11-11T14:03:00Z',
    });
  });

  it('without a restart mark, the second pass line after the change is the first that counts', () => {
    const change = { at: '2026-11-11T14:02:00Z', startedAfter: null as string | null };
    const first = parseIndexerLog(pass('2026-11-11T14:02:05Z', { failed: { work: 4 } }));
    expect(accountState('work', host, change, first).state).toBe('waiting');
    const second = parseIndexerLog(
      [pass('2026-11-11T14:02:05Z', { failed: { work: 4 } }), '2026-11-11T14:17:05Z {"error":"1"}', pass('2026-11-11T14:32:05Z')].join('\n'),
    );
    expect(accountState('work', host, change, second)).toMatchObject({ state: 'indexed', indexedAt: '2026-11-11T14:32:05Z' });
  });
});
