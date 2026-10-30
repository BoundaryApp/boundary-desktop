import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunningWorkItem } from '../../../../shared/types/updates';
import { UpdateService, type UpdateStoreShape } from '../UpdateService';

const feed = (version: string) =>
  JSON.stringify({
    currentRelease: version,
    releases: [{ version, updateTo: { version, notes: 'Line' } }],
  });

class FakeUpdater extends EventEmitter {
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn();
}

function setup(overrides: { version?: string; feedBase?: string; inApplications?: boolean } = {}) {
  const values: UpdateStoreShape = {};
  const updater = new FakeUpdater();
  const fetchText = vi.fn(async (_url: string) => feed('0.0.1-rc.10'));
  const runningWork = vi.fn(async (): Promise<RunningWorkItem[]> => []);
  const installAndRestart = vi.fn();
  const service = new UpdateService({
    currentVersion: overrides.version ?? '0.0.1-rc.9',
    arch: 'arm64',
    feedBase: overrides.feedBase ?? 'https://x.test/f',
    inApplications: () => overrides.inApplications ?? true,
    fetchText,
    updater,
    store: {
      get: (key) => values[key],
      set: (key, value) => {
        values[key] = value as never;
      },
    },
    runningWork,
    installAndRestart,
    onChange: vi.fn(),
    log: vi.fn(),
  });
  return { service, updater, fetchText, runningWork, installAndRestart, values };
}

async function ready(service: UpdateService, updater: FakeUpdater) {
  await service.check({ manual: false });
  service.download();
  updater.emit('update-downloaded');
}

describe('UpdateService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('offers a newer version and does not touch Squirrel until Download', async () => {
    const { service, updater, fetchText } = setup();
    const snapshot = await service.check({ manual: false });
    expect(fetchText).toHaveBeenCalledWith('https://x.test/f/beta-darwin-arm64.json');
    expect(snapshot).toMatchObject({ phase: 'available', version: '0.0.1-rc.10', showNotice: true });
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

  it('closes the ask once per version, and shows the ready notice afterwards', async () => {
    const { service, updater } = setup();
    await service.check({ manual: false });
    service.closeNotice();
    expect(service.snapshot().showNotice).toBe(false);
    await service.check({ manual: false });
    expect(service.snapshot().showNotice).toBe(false);
    service.download();
    expect(service.snapshot().showNotice).toBe(false);
    updater.emit('update-downloaded');
    expect(service.snapshot().showNotice).toBe(true);
  });

  it('clears the dot when the Updates tab opens', async () => {
    const { service } = setup();
    await service.check({ manual: false });
    expect(service.snapshot().showDot).toBe(true);
    service.markPageSeen();
    expect(service.snapshot().showDot).toBe(false);
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
    const item = { id: 'task:1', title: 'Report', detail: 'Board task' };
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
    const first = { id: 'task:1', title: 'A', detail: '' };
    const later = { id: 'task:2', title: 'B', detail: '' };
    service.restartWhenFinished([first]);
    expect(service.snapshot().waitingFor).toBe(1);
    runningWork.mockResolvedValue([first, later]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(installAndRestart).not.toHaveBeenCalled();
    runningWork.mockResolvedValue([later]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(installAndRestart).toHaveBeenCalledOnce();
  });

  it('cancels a waiting restart', async () => {
    const { service, updater, runningWork, installAndRestart } = setup();
    await ready(service, updater);
    service.restartWhenFinished([{ id: 'task:1', title: 'A', detail: '' }]);
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
    expect(fetchText).toHaveBeenCalledWith('https://x.test/f/beta-darwin-arm64.json');
  });
});
