import { describe, expect, it } from 'vitest';
import type { ContentSources } from '../content';
import { buildContent, loadReleases } from '../content';

const sources: ContentSources = {
  releases: [
    { version: '0.0.1-rc.11', date: 'Nov 13' },
    { version: '0.0.1-rc.10', date: 'Nov 12' },
  ],
  details: {
    '0.0.1-rc.11': {
      slides: [{ title: 'React to Circle messages', body: 'Hover a message.', image: 'reactions', guide: 'reactions' }],
      guides: ['calendars'],
    },
    '0.0.1-rc.10': { slides: [{ title: 'Shared folders', body: 'Share a folder.', image: 'folders' }] },
  },
  guides: {
    reactions: {
      title: 'React to a Circle message',
      minutes: 1,
      steps: [{ title: 'Hover the message', image: 'hover', callouts: [{ anchor: 'msg', text: 'Hover any message.' }] }],
    },
  },
  images: {
    '0.0.1-rc.11/reactions': '/assets/reactions-a1b2.png',
    '0.0.1-rc.10/folders': '/assets/folders-c3d4.png',
    'guides/reactions/hover': '/assets/hover-e5f6.png',
  },
  boxes: { '0.0.1-rc.11/reactions': { msg: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } } },
};

describe('buildContent', () => {
  it('returns releases newest first', () => {
    expect(buildContent(sources).releases.map((release) => release.version)).toEqual([
      '0.0.1-rc.11',
      '0.0.1-rc.10',
    ]);
  });

  it('carries a release’s slides and guide list', () => {
    const [latest] = buildContent(sources).releases;
    expect(latest.slides[0].title).toBe('React to Circle messages');
    expect(latest.guides).toEqual(['calendars']);
  });

  it('leaves a release with no detail file out', () => {
    const thin = { ...sources, details: {} };
    expect(buildContent(thin).releases).toEqual([]);
  });

  it('resolves a slide image to a url', () => {
    expect(buildContent(sources).imageUrl('0.0.1-rc.11', 'reactions')).toMatch(/\.png$/);
  });

  it('returns null when a slide has no screenshot', () => {
    expect(buildContent(sources).imageUrl('0.0.1-rc.11', undefined)).toBeNull();
  });

  it('returns null for a missing image', () => {
    expect(buildContent(sources).imageUrl('0.0.1-rc.11', 'gone')).toBeNull();
  });

  it('keeps a guide’s images apart from a release’s', () => {
    expect(buildContent(sources).imageUrl('guides/reactions', 'hover')).toBe('/assets/hover-e5f6.png');
  });

  it('returns a guide by id', () => {
    expect(buildContent(sources).guide('reactions')?.steps).toHaveLength(1);
  });

  it('returns null for an unknown guide', () => {
    expect(buildContent(sources).guide('nope')).toBeNull();
  });

  it('returns the boxes a screenshot’s sidecar holds', () => {
    expect(buildContent(sources).anchorBoxes('0.0.1-rc.11', 'reactions').msg).toEqual({
      x: 0.1,
      y: 0.2,
      w: 0.3,
      h: 0.1,
    });
  });

  it('returns no boxes when a sidecar is missing', () => {
    expect(buildContent(sources).anchorBoxes('0.0.1-rc.11', 'nosidecar')).toEqual({});
  });
});

describe('the bundled content', () => {
  it('is empty when the build bundles none', () => {
    expect(loadReleases()).toEqual([]);
  });
});
