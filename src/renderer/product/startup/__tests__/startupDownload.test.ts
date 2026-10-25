import { describe, expect, it } from 'vitest';
import { formatBytes, summarizeDownload, tallyDownload, type DownloadTally } from '../../../../shared/startupDownload';

const layer = (id: string, text: string, current?: number, total?: number) => ({
  id,
  parent_id: 'Image ghcr.io/example/hermes:1',
  status: 'Working',
  text,
  ...(current !== undefined ? { current } : {}),
  ...(total !== undefined ? { total } : {}),
});

describe('tallyDownload', () => {
  it('sums layer bytes as they arrive', () => {
    let tally: DownloadTally = {};
    tally = tallyDownload(tally, layer('a', 'Downloading', 10, 100));
    tally = tallyDownload(tally, layer('b', 'Downloading', 5, 50));
    tally = tallyDownload(tally, layer('a', 'Downloading', 60, 100));
    expect(summarizeDownload(tally)).toEqual({ receivedBytes: 65, seenBytes: 150 });
  });

  it('counts a finished layer in full and never goes backwards', () => {
    let tally: DownloadTally = {};
    tally = tallyDownload(tally, layer('a', 'Downloading', 80, 100));
    tally = tallyDownload(tally, layer('a', 'Extracting', 3, 100));
    expect(summarizeDownload(tally).receivedBytes).toBe(100);
    tally = tallyDownload(tally, layer('a', 'Downloading', 20, 100));
    expect(summarizeDownload(tally).receivedBytes).toBe(100);
  });

  it('ignores service rows and events without sizes', () => {
    const empty: DownloadTally = {};
    expect(tallyDownload(empty, { id: 'Container boundary-hermes', status: 'Working', text: 'Starting' })).toBe(empty);
    expect(tallyDownload(empty, { id: 'Image ghcr.io/x', parent_id: 'p', text: 'Pulling' })).toBe(empty);
    expect(tallyDownload(empty, layer('a', 'Pulling fs layer'))).toBe(empty);
  });

  it('returns the same tally when nothing changed', () => {
    const tally = tallyDownload({}, layer('a', 'Downloading', 10, 100));
    expect(tallyDownload(tally, layer('a', 'Downloading', 10, 100))).toBe(tally);
  });
});

describe('formatBytes', () => {
  it('uses decimal units', () => {
    expect(formatBytes(1_234_000_000)).toBe('1.2 GB');
    expect(formatBytes(9_400_000)).toBe('9 MB');
    expect(formatBytes(512_000)).toBe('512 KB');
  });
});
