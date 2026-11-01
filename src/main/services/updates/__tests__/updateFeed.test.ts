import { describe, expect, it, vi } from 'vitest';
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider';
import { channelName, compareVersions, defaultChannel, parseOffer } from '../updateFeed';

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

describe('parseOffer', () => {
  it('reads notes, size and the stack version', () => {
    expect(
      parseOffer({
        version: '0.0.1',
        releaseNotes: 'One\n\n Two ',
        files: [{ size: 5 }],
        stackVersion: 'v0.3.7',
      })
    ).toEqual({ version: '0.0.1', summary: ['One', 'Two'], size: 5, stackVersion: 'v0.3.7' });
  });

  it('leaves out what the channel file does not give', () => {
    expect(parseOffer({ version: '0.0.1' })).toEqual({
      version: '0.0.1',
      summary: [],
      size: null,
      stackVersion: null,
    });
  });
});

it('names the file the release workflows upload', async () => {
  const requested: string[] = [];
  const provider = new GenericProvider(
    { provider: 'generic', url: 'https://x.test/f' },
    { channel: channelName('beta', 'arm64'), isAddNoCacheQuery: false } as never,
    { platform: 'darwin', executor: null as never, isUseMultipleRangeRequest: false }
  );
  vi.spyOn(provider as never as { httpRequest: (url: URL) => Promise<string> }, 'httpRequest')
    .mockImplementation(async (url) => {
      requested.push(url.href);
      return '{"version":"0.0.1","files":[]}';
    });
  await provider.getLatestVersion();
  expect(requested).toEqual(['https://x.test/f/beta-darwin-arm64-mac.yml']);
});

it('starts prerelease builds on beta', () => {
  expect(defaultChannel('0.0.1-rc.9')).toBe('beta');
  expect(defaultChannel('0.0.1')).toBe('stable');
});
