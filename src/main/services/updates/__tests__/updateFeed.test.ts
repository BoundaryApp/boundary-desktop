import { describe, expect, it } from 'vitest';
import { compareVersions, defaultChannel, feedUrl, parseFeed } from '../updateFeed';

describe('compareVersions', () => {
  it.each([
    ['0.0.1-rc.10', '0.0.1-rc.9', 1],
    ['0.0.1', '0.0.1-rc.9', 1],
    ['0.0.1-rc.9', '0.0.1', -1],
    ['0.0.2-rc.1', '0.0.1', 1],
    ['0.0.1', '0.0.1', 0],
  ])('%s vs %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b) ?? NaN)).toBe(sign);
  });

  it('returns null for a version that does not parse', () => {
    expect(compareVersions('latest', '0.0.1')).toBeNull();
  });
});

describe('parseFeed', () => {
  it('reads the real version under a label', () => {
    const feed = JSON.stringify({
      currentRelease: '0.0.1-rc.999999',
      releases: [{ version: '0.0.1-rc.999999', updateTo: { version: '0.0.1', notes: 'Line' } }],
    });
    expect(parseFeed(feed)).toEqual({ version: '0.0.1', summary: 'Line' });
  });

  it.each(['not json', 'null', '{}', '{"currentRelease":"1.0.0","releases":[]}'])(
    'rejects %s',
    (text) => {
      expect(parseFeed(text)).toBeNull();
    }
  );
});

it('builds the feed URL for a channel and architecture', () => {
  expect(feedUrl('https://x.test/f/', 'beta', 'arm64')).toBe(
    'https://x.test/f/beta-darwin-arm64.json'
  );
});

it('starts prerelease builds on beta', () => {
  expect(defaultChannel('0.0.1-rc.9')).toBe('beta');
  expect(defaultChannel('0.0.1')).toBe('stable');
});
