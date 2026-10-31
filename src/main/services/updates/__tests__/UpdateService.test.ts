import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunningWorkItem } from '../../../../shared/types/updates';
import { FeedKeyRejected, UpdateService, type FeedKey, type UpdateStoreShape } from '../UpdateService';

const feed = (version: string) =>
  JSON.stringify({
    currentRelease: version,
    releases: [{ version, updateTo: { version, notes: 'Line' } }],
  });

class FakeUpdater extends EventEmitter {
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn();
}

function setup(
  overrides: { version?: string; feedBase?: string; inApplications?: boolean; feedKey?: FeedKey } = {}
) {
  const values: UpdateStoreShape = {};
  const updater = new FakeUpdater();
  const fetchText = vi.fn(async (_url: string, _headers: Record<string, string>) =>
    feed('0.0.1-rc.10')
  );
  const runningWork = vi.fn(async (): Promise<RunningWorkItem[]> => []);
  const installAndRestart = vi.fn();
  const onChange = vi.fn();
  const service = new UpdateService({
    currentVersion: overrides.version ?? '0.0.1-rc.9',
    stackVersion: 'v0.3.7',
    arch: 'arm64',
    feedBase: overrides.feedBase ?? 'https://x.test/f',
    inApplications: () => overrides.inApplications ?? true,
    fetchText,
    feedKey: overrides.feedKey,
    updater,
    store: {
      get: (key) => values[key],
      set: (key, value) => {
        values[key] = value as never;
      },
    },
    runningWork,
    installAndRestart,
    onChange,
    log: vi.fn(),
  });
  return { service, updater, fetchText, runningWork, installAndRestart, values, onChange };
}

async function ready(service: UpdateService, updater: FakeUpdater) {
  await service.check({ manual: false });
  service.download();
  updater.emit('update-downloaded');
}

describe('UpdateService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe('feed key', () => {
    const feedKey = (initial: string | null = null): FeedKey => {
      let key = initial;
      return {
        stored: () => key !== null,
        read: async () => key,
        write: async (next) => {
          key = next;
        },
      };
    };

    it('stays blocked and sends nothing until a key is saved', async () => {
      const { service, fetchText } = setup({ feedKey: feedKey() });
      expect(service.snapshot()).toMatchObject({ blocked: 'no-key', keyRequired: true });
      await service.check({ manual: true });
      expect(fetchText).not.toHaveBeenCalled();
    });

    it('sends the saved key on the check and hands it to Squirrel', async () => {
      const { service, fetchText, updater } = setup({ feedKey: feedKey() });
      await service.setFeedKey('  abc \n');
      await vi.advanceTimersByTimeAsync(0);
      expect(service.snapshot().phase).toBe('available');
      const headers = { Authorization: 'Bearer abc' };
      expect(fetchText).toHaveBeenCalledWith('https://x.test/f/beta-darwin-arm64.json', headers);
      service.download();
      expect(updater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({ headers }));
      service.stop();
    });

    it('reports a refused key apart from an unreachable feed', async () => {
      const { service, fetchText } = setup({ feedKey: feedKey('old') });
      fetchText.mockRejectedValue(new FeedKeyRejected());
      expect((await service.check({ manual: true })).error).toBe('key');
    });
  });

  it('offers a newer version and does not touch Squirrel until Download', async () => {
    const { service, updater, fetchText } = setup();
    const snapshot = await service.check({ manual: false });
    expect(fetchText).toHaveBeenCalledWith('https://x.test/f/beta-darwin-arm64.json', {});
    expect(snapshot).toMatchObject({ phase: 'available', version: '0.0.1-rc.10', showCard: true });
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('offers nothing after a labelled final release has installed', async () => {
    const { service, fetchText } = setup({ version: '0.0.1' });
    fetchText.mockResolvedValue(
      JSON.stringify({
        currentRelease: '0.0.1-rc.999999',
        releases: [{ version: '0.0.1-rc.999999', updateTo: { version: '0.0.1' } }],
      })
    );
    expect((await service.check({ manual: false })).phase).toBe('idle');
  });

  it('stays off without a feed or outside Applications', async () => {
    const noFeed = setup({ feedBase: '' });
    expect((await noFeed.service.check({ manual: true })).blocked).toBe('no-feed');
    expect(noFeed.fetchText).not.toHaveBeenCalled();
    const elsewhere = setup({ inApplications: false });
    elsewhere.service.start();
    expect(elsewhere.service.snapshot().blocked).toBe('not-in-applications');
    expect(elsewhere.fetchText).not.toHaveBeenCalled();
  });

  it('reports an unreachable or unreadable feed and keeps the last check time', async () => {
    const { service, fetchText, values } = setup();
    fetchText.mockRejectedValueOnce(new Error('offline'));
    expect(await service.check({ manual: true })).toMatchObject({ error: 'check', phase: 'idle' });
    fetchText.mockResolvedValueOnce('<html>');
    expect((await service.check({ manual: true })).error).toBe('check');
    expect(values.lastCheckedAt).toBeUndefined();
  });

  it('downloads through Squirrel with a JSON feed and becomes ready', async () => {
    const { service, updater } = setup();
    await service.check({ manual: false });
    expect(service.download().phase).toBe('downloading');
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      url: 'https://x.test/f/beta-darwin-arm64.json',
      serverType: 'json',
      headers: {},
    });
    updater.emit('update-downloaded');
    expect(service.snapshot().phase).toBe('ready');
  });

  it('returns to available with an error when the download fails', async () => {
    const { service, updater } = setup();
    await service.check({ manual: false });
    service.download();
    updater.emit('error', new Error('bad signature'));
    expect(service.snapshot()).toMatchObject({ phase: 'available', error: 'download' });
  });

  it('survives setFeedURL throwing on an unsigned build', async () => {
    const { service, updater } = setup();
    await service.check({ manual: false });
    updater.setFeedURL.mockImplementation(() => {
      throw new Error('Could not get code signature');
    });
    expect(service.download()).toMatchObject({ phase: 'available', error: 'download' });
  });

  it('closes the ask once per version, and opens the card again when ready', async () => {
    const { service, updater } = setup();
    await service.check({ manual: false });
    service.closeCard();
    expect(service.snapshot().showCard).toBe(false);
    await service.check({ manual: false });
    expect(service.snapshot().showCard).toBe(false);
    service.download();
    expect(service.snapshot().showCard).toBe(false);
    updater.emit('update-downloaded');
    expect(service.snapshot().showCard).toBe(true);
  });

  it('opens the card when a hidden download fails', async () => {
    const { service, updater } = setup();
    await service.check({ manual: false });
    service.download();
    service.closeCard();
    updater.emit('error', new Error('bad signature'));
    expect(service.snapshot()).toMatchObject({ error: 'download', showCard: true });
  });

  it('reads size, summary lines and whether the update moves the stack', async () => {
    const { service, fetchText } = setup();
    fetchText.mockResolvedValue(
      JSON.stringify({
        currentRelease: '0.0.1-rc.10',
        releases: [
          {
            version: '0.0.1-rc.10',
            updateTo: {
              version: '0.0.1-rc.10',
              notes: 'One\n\n  Two \n',
              size: 324000000,
              stackVersion: 'v0.3.8',
            },
          },
        ],
      })
    );
    expect(await service.check({ manual: false })).toMatchObject({
      summary: ['One', 'Two'],
      size: 324000000,
      stackChanges: true,
    });
  });

  it('says nothing about the stack when the feed names no stack version', async () => {
    const { service } = setup();
    expect(await service.check({ manual: false })).toMatchObject({ size: null, stackChanges: false });
  });

  it('shows the finished update once, and keeps it for the Updates page', async () => {
    const first = setup();
    await ready(first.service, first.updater);
    expect(first.service.snapshot().updated).toBeNull();
    const installing = first.values.installing;
    const next = setup({ version: '0.0.1-rc.10' });
    next.values.installing = installing;
    expect(next.service.snapshot()).toMatchObject({
      updated: { version: '0.0.1-rc.10', summary: ['Line'] },
      showUpdated: true,
    });
    next.service.closeUpdated();
    expect(next.service.snapshot()).toMatchObject({
      updated: { version: '0.0.1-rc.10' },
      showUpdated: false,
    });
  });

  it('skips a version until a newer one, or a manual check', async () => {
    const { service, fetchText } = setup();
    await service.check({ manual: false });
    service.skipVersion();
    expect((await service.check({ manual: false })).phase).toBe('idle');
    expect((await service.check({ manual: true })).phase).toBe('available');
    service.skipVersion();
    fetchText.mockResolvedValue(feed('0.0.1-rc.11'));
    expect((await service.check({ manual: false })).version).toBe('0.0.1-rc.11');
  });

  it('restarts with nothing running, and names the work otherwise', async () => {
    const { service, updater, runningWork, installAndRestart } = setup();
    await ready(service, updater);
    const item = { id: 'task:1', kind: 'task' as const, title: 'Report', detail: 'Board task' };
    runningWork.mockResolvedValueOnce([item]);
    expect(await service.restart({ force: false })).toEqual({
      status: 'work-running',
      items: [item],
    });
    expect(installAndRestart).not.toHaveBeenCalled();
    expect(await service.restart({ force: false })).toEqual({ status: 'restarting' });
    expect(installAndRestart).toHaveBeenCalledOnce();
  });

  it('will not restart before the download finished', async () => {
    const { service, installAndRestart } = setup();
    expect(await service.restart({ force: true })).toEqual({ status: 'not-ready' });
    expect(installAndRestart).not.toHaveBeenCalled();
  });

  it('waits only for the work that was running', async () => {
    const { service, updater, runningWork, installAndRestart } = setup();
    await ready(service, updater);
    const first = { id: 'task:1', kind: 'task' as const, title: 'A', detail: '' };
    const second = { id: 'task:2', kind: 'task' as const, title: 'B', detail: '' };
    const later = { id: 'task:3', kind: 'task' as const, title: 'C', detail: '' };
    service.restartWhenFinished([first, second]);
    expect(service.snapshot().waiting).toHaveLength(2);
    runningWork.mockResolvedValue([second, later]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.snapshot().waiting.map((item) => item.finished)).toEqual([true, false]);
    runningWork.mockResolvedValue([later]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.snapshot()).toMatchObject({ waiting: [], restartIn: 30 });
    expect(installAndRestart).not.toHaveBeenCalled();
  });

  it('gives a last call before a waited-for restart, then says it reopens', async () => {
    const { service, updater, runningWork, installAndRestart, onChange } = setup();
    await ready(service, updater);
    service.restartWhenFinished([{ id: 'task:1', kind: 'task', title: 'A', detail: '' }]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runningWork).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(service.snapshot().restartIn).toBe(1);
    expect(installAndRestart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(installAndRestart).toHaveBeenCalledOnce();
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ restarting: true, restartIn: null });
  });

  it('stops the last call on Not now, and the update stays ready', async () => {
    const { service, updater, installAndRestart } = setup();
    await ready(service, updater);
    service.restartWhenFinished([{ id: 'task:1', kind: 'task', title: 'A', detail: '' }]);
    await vi.advanceTimersByTimeAsync(15_000);
    service.cancelWaiting();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(installAndRestart).not.toHaveBeenCalled();
    expect(service.snapshot()).toMatchObject({ phase: 'ready', restartIn: null });
  });

  it('restarts at once from the last call', async () => {
    const { service, updater, installAndRestart } = setup();
    await ready(service, updater);
    service.restartWhenFinished([{ id: 'task:1', kind: 'task', title: 'A', detail: '' }]);
    await vi.advanceTimersByTimeAsync(15_000);
    await service.restart({ force: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(installAndRestart).toHaveBeenCalledOnce();
  });

  it('cancels a waiting restart', async () => {
    const { service, updater, runningWork, installAndRestart } = setup();
    await ready(service, updater);
    service.restartWhenFinished([{ id: 'task:1', kind: 'task', title: 'A', detail: '' }]);
    service.cancelWaiting();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runningWork).not.toHaveBeenCalled();
    expect(installAndRestart).not.toHaveBeenCalled();
  });

  it('checks daily, and not at all with checks off', async () => {
    const { service, fetchText, values } = setup();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchText).toHaveBeenCalledTimes(1);
    values.checksEnabled = false;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(fetchText).toHaveBeenCalledTimes(1);
    values.checksEnabled = true;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(fetchText).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it('keeps a stored channel across versions', async () => {
    const { service, fetchText, values } = setup({ version: '0.0.1' });
    values.channel = 'beta';
    await service.check({ manual: false });
    expect(fetchText).toHaveBeenCalledWith('https://x.test/f/beta-darwin-arm64.json', {});
  });
});
