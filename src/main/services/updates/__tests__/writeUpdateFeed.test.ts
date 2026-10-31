import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SOVEREIGN_AGENT_STACK_VERSION } from '../../../../shared/assistantStackConstants';
import { buildFeed, feedLabel, pinnedStackVersion } from '../../../../../scripts/write-update-feed.mjs';

const release = {
  version: '0.0.1',
  url: 'https://example.com/a.zip',
  sha256: 'ab',
  size: 1,
  notes: 'Line',
  pubDate: '2026-11-02T18:00:00Z',
};

describe('write-update-feed', () => {
  it('finds the pinned stack version in the constants file', () => {
    const source = readFileSync('src/shared/assistantStackConstants.ts', 'utf8');
    expect(pinnedStackVersion(source)).toBe(SOVEREIGN_AGENT_STACK_VERSION);
  });

  it('labels a final release above its RCs on the beta feed only', () => {
    expect(feedLabel('beta', '0.0.1')).toBe('0.0.1-rc.999999');
    expect(feedLabel('stable', '0.0.1')).toBe('0.0.1');
    expect(feedLabel('beta', '0.0.1-rc.10')).toBe('0.0.1-rc.10');
  });

  it('keeps the real version in updateTo under a label', () => {
    const feed = buildFeed({ ...release, channel: 'beta' });
    expect(feed.currentRelease).toBe('0.0.1-rc.999999');
    expect(feed.releases[0].version).toBe('0.0.1-rc.999999');
    expect(feed.releases[0].updateTo.version).toBe('0.0.1');
    expect(feed.releases[0].updateTo.sha256).toBe('ab');
  });
});
