import { EventEmitter } from 'node:events';
import type { OutgoingHttpHeaders } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CancellationToken } from 'electron-updater';
import type { RunningWorkItem } from '../../../../shared/types/updates';
import {
  UpdateService,
  type AppUpdater,
  type FeedKey,
  type UpdateStoreShape,
} from '../UpdateService';
import { compareVersions, type ChannelInfo } from '../updateFeed';

const channelFile = (version: string, extra: Partial<ChannelInfo> = {}): ChannelInfo => ({
  version,
  releaseNotes: 'Line',
  files: [{}],
  ...extra,
});

/** Mirrors electron-updater 6.8: offers only a strictly newer version with downgrades off. */
class FakeUpdater extends EventEmitter {
  channel: string | null = null;
  allowDowngrade = true;
  requestHeaders: OutgoingHttpHeaders | null = null;
  headersOnCheck: (OutgoingHttpHeaders | null)[] = [];
  headersOnDownload: (OutgoingHttpHeaders | null)[] = [];
  info = channelFile('0.0.1-rc.10');
  current = '0.0.1-rc.9';
  checkFails: Error | null = null;
  download = vi.fn(async (_token: CancellationToken): Promise<unknown> => []);
  checkForUpdates: AppUpdater['checkForUpdates'] = vi.fn(async () => {
    this.headersOnCheck.push(this.requestHeaders);
    if (this.checkFails) throw this.checkFails;
    return {
      isUpdateAvailable: (compareVersions(this.info.version, this.current) ?? 0) > 0,
      updateInfo: this.info,
    };
  });
  downloadUpdate = (token: CancellationToken) => {
    this.headersOnDownload.push(this.requestHeaders);
    return this.download(token);
  };
}

function setup(
  overrides: { version?: string; feedBase?: string; inApplications?: boolean; feedKey?: FeedKey } = {}
) {
  const values: UpdateStoreShape = {};
  const updater = new FakeUpdater();
  updater.current = overrides.version ?? '0.0.1-rc.9';
  const squirrel = new EventEmitter();
  const runningWork = vi.fn(async (): Promise<RunningWorkItem[]> => []);
  const installAndRestart = vi.fn();
  const onChange = vi.fn();
  const service = new UpdateService({
    currentVersion: updater.current,
    stackVersion: 'v0.3.7',
    arch: 'arm64',
    feedBase: overrides.feedBase ?? 'https://x.test/f',
    inApplications: () => overrides.inApplications ?? true,
    feedKey: overrides.feedKey,
    updater,
    squirrel,
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
  return { service, updater, squirrel, runningWork, installAndRestart, values, onChange };
}

async function ready(service: UpdateService, updater: FakeUpdater, squirrel: EventEmitter) {
  await service.check({ manual: false });
  service.download();
  updater.emit('update-downloaded');
  squirrel.emit('update-downloaded');
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
      const { service, updater } = setup({ feedKey: feedKey() });
      expect(service.snapshot()).toMatchObject({ blocked: 'no-key', keyRequired: true });
      await service.check({ manual: true });
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('sends the saved key on the check and keeps it off the zip', async () => {
      const { service, updater } = setup({ feedKey: feedKey() });
      await service.setFeedKey('  abc \n');
      await vi.advanceTimersByTimeAsync(0);
      expect(service.snapshot().phase).toBe('available');
      expect(updater.headersOnCheck).toContainEqual({ Authorization: 'Bearer abc' });
      service.download();
      expect(updater.headersOnDownload).toEqual([null]);
      service.stop();
    });

    it.each([401, 403])('reports a refused key on %i apart from an unreachable feed', async (statusCode) => {
      const { service, updater } = setup({ feedKey: feedKey('old') });
      updater.checkFails = Object.assign(new Error('refused'), { statusCode });
      expect((await service.check({ manual: true })).error).toBe('key');
    });
  });

  it('offers a newer version and downloads nothing until Download', async () => {
    const { service, updater } = setup();
    const snapshot = await service.check({ manual: false });
    expect(updater.channel).toBe('beta-darwin-arm64');
    expect(snapshot).toMatchObject({ phase: 'available', version: '0.0.1-rc.10', showCard: true });
    expect(updater.download).not.toHaveBeenCalled();
  });

  it('turns downgrades off on every check, because setting a channel turns them on', async () => {
    const { service, updater } = setup();
    await service.check({ manual: false });
    expect(updater.allowDowngrade).toBe(false);
  });

  it('offers a final release to its RC, and nothing once it has installed', async () => {
    const rc = setup();
    rc.updater.info = channelFile('0.0.1');
    expect((await rc.service.check({ manual: false })).version).toBe('0.0.1');
    const final = setup({ version: '0.0.1' });
    final.updater.info = channelFile('0.0.1');
    expect((await final.service.check({ manual: false })).phase).toBe('idle');
  });

  it('stays off without a feed or outside Applications', async () => {
    const noFeed = setup({ feedBase: '' });
    expect((await noFeed.service.check({ manual: true })).blocked).toBe('no-feed');
    expect(noFeed.updater.checkForUpdates).not.toHaveBeenCalled();
    const elsewhere = setup({ inApplications: false });
    elsewhere.service.start();
    expect(elsewhere.service.snapshot().blocked).toBe('not-in-applications');
    expect(elsewhere.updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('reports an unreachable feed, or an inactive updater, and keeps the last check time', async () => {
    const { service, updater, values } = setup();
    updater.checkFails = new Error('offline');
    expect(await service.check({ manual: true })).toMatchObject({ error: 'check', phase: 'idle' });
    updater.checkFails = null;
    vi.mocked(updater.checkForUpdates).mockResolvedValueOnce(null);
    expect((await service.check({ manual: true })).error).toBe('check');
    expect(values.lastCheckedAt).toBeUndefined();
  });

  it('is ready only when Squirrel has accepted the zip', async () => {
    const { service, updater, squirrel } = setup();
    await service.check({ manual: false });
    expect(service.download().phase).toBe('downloading');
    expect(updater.download).toHaveBeenCalledOnce();
    updater.emit('update-downloaded');
    expect(service.snapshot()).toMatchObject({ phase: 'downloading', downloadPercent: 100 });
    squirrel.emit('update-downloaded');
    expect(service.snapshot()).toMatchObject({ phase: 'ready', downloadPercent: null });
  });

  it('reports whole percents, once each, and 100 only when the zip is complete', async () => {
    const { service, updater, onChange } = setup();
    await service.check({ manual: false });
    onChange.mockClear();
    service.download();
    for (const percent of [0.5, 0.6, 42.9, 100]) updater.emit('download-progress', { percent });
    expect(onChange.mock.calls.map(([snapshot]) => snapshot.downloadPercent)).toEqual([null, 0, 42, 99]);
    updater.emit('update-downloaded');
    expect(service.snapshot().downloadPercent).toBe(100);
  });

  it('returns to available when the download fails', async () => {
    const { service, updater } = setup();
    await service.check({ manual: false });
    updater.download.mockRejectedValueOnce(new Error('offline'));
    service.download();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.snapshot()).toMatchObject({
      phase: 'available',
      error: 'download',
      downloadPercent: null,
    });
  });

  it('returns to available with an error when Squirrel refuses the update', async () => {
    const { service, updater } = setup();
    await service.check({ manual: false });
    service.download();
    updater.emit('update-downloaded');
    updater.emit('error', new Error('bad signature'));
    expect(service.snapshot()).toMatchObject({ phase: 'available', error: 'download' });
  });

  it('ignores an error from a check while nothing is downloading', async () => {
    const { service, updater } = setup();
    await service.check({ manual: false });
    updater.emit('error', new Error('offline'));
    expect(service.snapshot()).toMatchObject({ phase: 'available', error: null });
  });

  it('cancels a download that receives nothing for 60 seconds', async () => {
    const { service, updater } = setup();
    await service.check({ manual: false });
    service.download();
    const token = updater.download.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(59_000);
    updater.emit('download-progress', { percent: 10 });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(service.snapshot().phase).toBe('downloading');
    expect(token.cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.snapshot()).toMatchObject({ phase: 'available', error: 'download' });
    expect(token.cancelled).toBe(true);
  });

  it('does not time out while Squirrel checks the zip', async () => {
    const { service, updater } = setup();
    await service.check({ manual: false });
    service.download();
    updater.emit('update-downloaded');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(service.snapshot().phase).toBe('downloading');
  });

  it('keeps Try again running when the cancelled attempt rejects late', async () => {
    const { service, updater } = setup();
    await service.check({ manual: false });
    let rejectFirst: (error: Error) => void = () => undefined;
    updater.download.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectFirst = reject))
    );
    updater.download.mockImplementationOnce(() => new Promise(() => undefined));
    service.download();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.download().phase).toBe('downloading');
    rejectFirst(new Error('cancelled'));
    await vi.advanceTimersByTimeAsync(0);
    expect(service.snapshot()).toMatchObject({ phase: 'downloading', error: null });
  });

  it('closes the ask once per version, and opens the card again when ready', async () => {
    const { service, updater, squirrel } = setup();
    await service.check({ manual: false });
    service.closeCard();
    expect(service.snapshot().showCard).toBe(false);
    await service.check({ manual: false });
    expect(service.snapshot().showCard).toBe(false);
    service.download();
    expect(service.snapshot().showCard).toBe(false);
    updater.emit('update-downloaded');
    squirrel.emit('update-downloaded');
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
    const { service, updater } = setup();
    updater.info = channelFile('0.0.1-rc.10', {
      releaseNotes: 'One\n\n  Two \n',
      files: [{ size: 324000000 }],
      stackVersion: 'v0.3.8',
    });
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
    await ready(first.service, first.updater, first.squirrel);
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
    const { service, updater } = setup();
    await service.check({ manual: false });
    service.skipVersion();
    expect((await service.check({ manual: false })).phase).toBe('idle');
    expect((await service.check({ manual: true })).phase).toBe('available');
    service.skipVersion();
    updater.info = channelFile('0.0.1-rc.11');
    expect((await service.check({ manual: false })).version).toBe('0.0.1-rc.11');
  });

  it('restarts with nothing running, and names the work otherwise', async () => {
    const { service, updater, squirrel, runningWork, installAndRestart } = setup();
    await ready(service, updater, squirrel);
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
    const { service, updater, squirrel, runningWork, installAndRestart } = setup();
    await ready(service, updater, squirrel);
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
    const { service, updater, squirrel, runningWork, installAndRestart, onChange } = setup();
    await ready(service, updater, squirrel);
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
    const { service, updater, squirrel, installAndRestart } = setup();
    await ready(service, updater, squirrel);
    service.restartWhenFinished([{ id: 'task:1', kind: 'task', title: 'A', detail: '' }]);
    await vi.advanceTimersByTimeAsync(15_000);
    service.cancelWaiting();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(installAndRestart).not.toHaveBeenCalled();
    expect(service.snapshot()).toMatchObject({ phase: 'ready', restartIn: null });
  });

  it('restarts at once from the last call', async () => {
    const { service, updater, squirrel, installAndRestart } = setup();
    await ready(service, updater, squirrel);
    service.restartWhenFinished([{ id: 'task:1', kind: 'task', title: 'A', detail: '' }]);
    await vi.advanceTimersByTimeAsync(15_000);
    await service.restart({ force: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(installAndRestart).toHaveBeenCalledOnce();
  });

  it('cancels a waiting restart', async () => {
    const { service, updater, squirrel, runningWork, installAndRestart } = setup();
    await ready(service, updater, squirrel);
    service.restartWhenFinished([{ id: 'task:1', kind: 'task', title: 'A', detail: '' }]);
    service.cancelWaiting();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runningWork).not.toHaveBeenCalled();
    expect(installAndRestart).not.toHaveBeenCalled();
  });

  it('checks daily, and not at all with checks off', async () => {
    const { service, updater, values } = setup();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    values.checksEnabled = false;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    values.checksEnabled = true;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it('keeps a stored channel across versions', async () => {
    const { service, updater, values } = setup({ version: '0.0.1' });
    values.channel = 'beta';
    await service.check({ manual: false });
    expect(updater.channel).toBe('beta-darwin-arm64');
  });
});
