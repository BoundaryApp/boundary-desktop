import type { OutgoingHttpHeaders } from 'node:http';
import { CancellationToken } from 'electron-updater';
import type {
  RunningWorkItem,
  UpdateBlock,
  UpdateChannel,
  UpdatePhase,
  UpdateRestartResult,
  UpdateSnapshot,
  UpdateWaitItem,
} from '../../../shared/types/updates';
import {
  channelName,
  defaultChannel,
  parseOffer,
  type ChannelInfo,
  type UpdateOffer,
} from './updateFeed';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const WORK_POLL_MS = 15_000;
/** Longest a download may go without receiving a byte. Electron's `net` has no socket timeout. */
const STALL_MS = 60_000;
/** Time to read what just finished, or to stop the restart, before it goes ahead. */
const LAST_CALL_SECONDS = 30;

export interface UpdateStoreShape {
  channel?: UpdateChannel;
  checksEnabled?: boolean;
  lastCheckedAt?: string;
  skippedVersion?: string;
  /** `<version>:<stage>` of the last notice the user closed. */
  closedNotice?: string;
  /** The personal key for a gated feed, encrypted. */
  feedKey?: string;
  /** The update that installs on quit, for the card the next launch shows once. */
  installing?: { version: string; summary: string[] };
  /** The version whose after-update card was closed. */
  updatedSeen?: string;
}

export interface UpdateStore {
  get<K extends keyof UpdateStoreShape>(key: K): UpdateStoreShape[K];
  set<K extends keyof UpdateStoreShape>(key: K, value: NonNullable<UpdateStoreShape[K]>): void;
}

/** The part of electron-updater's autoUpdater this service uses. */
export interface AppUpdater {
  channel: string | null;
  allowDowngrade: boolean;
  requestHeaders: OutgoingHttpHeaders | null;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: ChannelInfo } | null>;
  downloadUpdate(cancellationToken: CancellationToken): Promise<unknown>;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
  /** The zip is here and its `sha512` matched. Squirrel hasn't looked at it yet. */
  on(event: 'update-downloaded', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** The part of Electron's autoUpdater this service uses: Squirrel's verdict on the zip. */
export interface SquirrelUpdater {
  on(event: 'update-downloaded' | 'update-not-available', listener: () => void): unknown;
}

/** The personal key a gated feed needs. It stays in the main process. */
export interface FeedKey {
  stored: () => boolean;
  /** Null when there is no key or it no longer decrypts. */
  read: () => Promise<string | null>;
  write: (key: string) => Promise<void>;
}

export interface UpdateServiceDeps {
  currentVersion: string;
  /** The stack version this build pins, to tell whether an update moves it. */
  stackVersion: string;
  arch: string;
  /** Empty when the build has no feed, as in dev builds and forks. */
  feedBase: string;
  inApplications: () => boolean;
  /** Set when this build's feed needs a personal key. */
  feedKey?: FeedKey;
  updater: AppUpdater;
  squirrel: SquirrelUpdater;
  store: UpdateStore;
  runningWork: () => Promise<RunningWorkItem[]>;
  /** Stop the stack the way a quit does, then hand over to Squirrel. */
  installAndRestart: () => void;
  onChange: (snapshot: UpdateSnapshot) => void;
  log: (message: string, details?: Record<string, unknown>) => void;
}

/** electron-updater's `ERR_UPDATER_…` code when it has one. These name no URL or path. */
function failureReason(error: unknown): string {
  const { code, name } = error as { code?: unknown; name?: unknown };
  if (typeof code === 'string') return code;
  return typeof name === 'string' ? name : typeof error;
}

/** Offers, downloads and installs app updates. Nothing downloads until the user says so. */
export class UpdateService {
  private offer: UpdateOffer | null = null;
  private phase: UpdatePhase = 'idle';
  private checking = false;
  private error: UpdateSnapshot['error'] = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private waitTimer: ReturnType<typeof setInterval> | null = null;
  private waiting: UpdateWaitItem[] = [];
  private restartIn: number | null = null;
  private lastCallTimer: ReturnType<typeof setInterval> | null = null;
  private restarting = false;
  private downloadPercent: number | null = null;
  private cancelDownload: CancellationToken | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {
    deps.updater.on('download-progress', ({ percent }) => this.received(percent));
    deps.updater.on('update-downloaded', () => {
      if (this.phase !== 'downloading') return;
      this.clearStallTimer();
      this.setDownloadPercent(100);
    });
    deps.updater.on('error', (error) => this.downloadFailed(failureReason(error)));
    deps.squirrel.on('update-downloaded', () => {
      if (this.phase !== 'downloading') return;
      this.endDownload();
      this.phase = 'ready';
      if (this.offer) {
        const { version, summary } = this.offer;
        this.deps.store.set('installing', { version, summary });
      }
      this.changed();
    });
    deps.squirrel.on('update-not-available', () => this.downloadFailed('update-not-available'));
  }

  start(): void {
    if (this.blocked() !== 'none') return;
    void this.scheduledCheck();
    this.checkTimer ??= setInterval(() => void this.scheduledCheck(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
    this.stopWaiting();
  }

  snapshot(): UpdateSnapshot {
    const { store, currentVersion } = this.deps;
    const version = this.phase === 'idle' ? null : (this.offer?.version ?? null);
    return {
      currentVersion,
      channel: this.channel(),
      checksEnabled: store.get('checksEnabled') ?? true,
      blocked: this.blocked(),
      phase: this.phase,
      version,
      summary: version ? (this.offer?.summary ?? []) : [],
      size: version ? (this.offer?.size ?? null) : null,
      downloadPercent: this.downloadPercent,
      stackChanges: version !== null && this.stackChanges(),
      checking: this.checking,
      lastCheckedAt: store.get('lastCheckedAt') ?? null,
      error: this.error,
      keyRequired: Boolean(this.deps.feedKey),
      showCard: version !== null && store.get('closedNotice') !== `${version}:${this.cardStage()}`,
      waiting: this.waiting,
      restartIn: this.restartIn,
      restarting: this.restarting,
      updated: this.updated(),
      showUpdated: this.updated() !== null && store.get('updatedSeen') !== currentVersion,
    };
  }

  /** A manual check also clears a skip, so a skipped version can be taken after all. */
  async check(options: { manual: boolean }): Promise<UpdateSnapshot> {
    if (this.blocked() !== 'none' || this.checking) return this.snapshot();
    if (this.phase === 'downloading' || this.phase === 'ready') return this.snapshot();
    const { store, updater, arch } = this.deps;
    this.checking = true;
    this.error = null;
    this.changed();
    try {
      updater.channel = channelName(this.channel(), arch);
      // Setting a channel turns downgrades on.
      updater.allowDowngrade = false;
      updater.requestHeaders = await this.readFeedHeaders();
      const result = await updater.checkForUpdates();
      if (!result) throw new Error('Updater inactive');
      const offer = parseOffer(result.updateInfo);
      store.set('lastCheckedAt', new Date().toISOString());
      if (options.manual && store.get('skippedVersion') === offer.version) {
        store.set('skippedVersion', '');
      }
      const wanted = result.isUpdateAvailable && store.get('skippedVersion') !== offer.version;
      this.offer = wanted ? offer : null;
      this.phase = wanted ? 'available' : 'idle';
    } catch (error) {
      const { statusCode } = error as { statusCode?: number };
      this.error = statusCode === 401 || statusCode === 403 ? 'key' : 'check';
      this.deps.log('update check failed', { reason: failureReason(error) });
    } finally {
      this.checking = false;
      this.changed();
    }
    return this.snapshot();
  }

  download(): UpdateSnapshot {
    if (this.phase !== 'available') return this.snapshot();
    this.phase = 'downloading';
    this.downloadPercent = null;
    this.error = null;
    this.changed();
    // The personal key is for the feed only. A gated feed's zip URL needs no credentials.
    this.deps.updater.requestHeaders = null;
    const token = new CancellationToken();
    this.cancelDownload = token;
    this.watchForStall();
    this.deps.updater.downloadUpdate(token).catch((error: unknown) => {
      // A cancelled attempt can reject after Try again has started the next one.
      if (this.cancelDownload === token) this.downloadFailed(failureReason(error));
    });
    return this.snapshot();
  }

  /** Held at 99 until the zip is complete, so 100 only ever means Squirrel has it. */
  private received(percent: number): void {
    if (this.phase !== 'downloading') return;
    this.watchForStall();
    this.setDownloadPercent(Math.min(99, Math.floor(percent)));
  }

  private watchForStall(): void {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      const cancel = this.cancelDownload;
      this.downloadFailed('stalled');
      cancel?.cancel();
    }, STALL_MS);
  }

  private clearStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private setDownloadPercent(percent: number): void {
    if (percent === this.downloadPercent) return;
    this.downloadPercent = percent;
    this.changed();
  }

  private endDownload(): void {
    this.clearStallTimer();
    this.cancelDownload = null;
    this.downloadPercent = null;
  }

  /** Restarts now when nothing is running or `force` is set; otherwise says what is running. */
  async restart(options: { force: boolean }): Promise<UpdateRestartResult> {
    if (this.phase !== 'ready') return { status: 'not-ready' };
    if (!options.force) {
      const items = await this.deps.runningWork();
      if (items.length > 0) return { status: 'work-running', items };
    }
    this.stopWaiting();
    this.install();
    return { status: 'restarting' };
  }

  /** Wait for the listed work only. Work started later doesn't postpone the restart. */
  restartWhenFinished(items: RunningWorkItem[]): void {
    if (this.phase !== 'ready') return;
    this.waiting = items.map((item) => ({ ...item, finished: false }));
    this.waitTimer ??= setInterval(() => void this.pollWork(), WORK_POLL_MS);
    this.changed();
  }

  cancelWaiting(): void {
    this.stopWaiting();
    this.changed();
  }

  closeCard(): void {
    const { version } = this.snapshot();
    if (version) this.deps.store.set('closedNotice', `${version}:${this.cardStage()}`);
    this.changed();
  }

  closeUpdated(): void {
    this.deps.store.set('updatedSeen', this.deps.currentVersion);
    this.changed();
  }

  skipVersion(): void {
    if (this.phase !== 'available' || !this.offer) return;
    this.deps.store.set('skippedVersion', this.offer.version);
    this.offer = null;
    this.phase = 'idle';
    this.changed();
  }

  setChannel(channel: UpdateChannel): Promise<UpdateSnapshot> {
    this.deps.store.set('channel', channel);
    if (this.phase === 'available') {
      this.offer = null;
      this.phase = 'idle';
    }
    return this.check({ manual: false });
  }

  setChecksEnabled(enabled: boolean): UpdateSnapshot {
    this.deps.store.set('checksEnabled', enabled);
    this.changed();
    return this.snapshot();
  }

  private channel(): UpdateChannel {
    return this.deps.store.get('channel') ?? defaultChannel(this.deps.currentVersion);
  }

  /** Saves a key and checks with it at once, so a bad key shows up where it was entered. */
  async setFeedKey(key: string): Promise<UpdateSnapshot> {
    await this.deps.feedKey?.write(key.trim());
    this.error = null;
    this.start();
    return this.check({ manual: false });
  }

  private async readFeedHeaders(): Promise<Record<string, string>> {
    const key = await this.deps.feedKey?.read();
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  private blocked(): UpdateBlock {
    if (!this.deps.feedBase) return 'no-feed';
    if (!this.deps.inApplications()) return 'not-in-applications';
    return this.deps.feedKey && !this.deps.feedKey.stored() ? 'no-key' : 'none';
  }

  /**
   * A closed card stays closed through a download, and returns once the update is ready, or if
   * the download fails, so a hidden download can't fail unseen.
   */
  private cardStage(): 'ask' | 'failed' | 'ready' | 'waiting' {
    if (this.waiting.length > 0) return 'waiting';
    if (this.phase === 'ready') return 'ready';
    return this.error === 'download' ? 'failed' : 'ask';
  }

  private stackChanges(): boolean {
    const offered = this.offer?.stackVersion;
    return Boolean(offered) && offered !== this.deps.stackVersion;
  }

  private updated(): UpdateSnapshot['updated'] {
    const installing = this.deps.store.get('installing');
    return installing?.version === this.deps.currentVersion ? installing : null;
  }

  private install(): void {
    this.restarting = true;
    this.changed();
    this.deps.installAndRestart();
  }

  private async scheduledCheck(): Promise<void> {
    if (this.deps.store.get('checksEnabled') ?? true) await this.check({ manual: false });
  }

  private downloadFailed(reason: string): void {
    if (this.phase !== 'downloading') return;
    this.deps.log('update download failed', { reason });
    this.endDownload();
    this.phase = 'available';
    this.error = 'download';
    this.changed();
  }

  private async pollWork(): Promise<void> {
    let items: RunningWorkItem[];
    try {
      items = await this.deps.runningWork();
    } catch {
      return;
    }
    if (this.waitTimer === null) return;
    const running = new Set(items.map((item) => item.id));
    this.waiting = this.waiting.map((item) => ({ ...item, finished: !running.has(item.id) }));
    if (this.waiting.every((item) => item.finished)) {
      this.stopWaiting();
      this.startLastCall();
    }
    this.changed();
  }

  private startLastCall(): void {
    this.restartIn = LAST_CALL_SECONDS;
    this.lastCallTimer = setInterval(() => {
      const left = (this.restartIn ?? 1) - 1;
      if (left > 0) {
        this.restartIn = left;
        this.changed();
        return;
      }
      this.stopWaiting();
      this.install();
    }, 1000);
  }

  private stopWaiting(): void {
    if (this.waitTimer) clearInterval(this.waitTimer);
    this.waitTimer = null;
    this.waiting = [];
    if (this.lastCallTimer) clearInterval(this.lastCallTimer);
    this.lastCallTimer = null;
    this.restartIn = null;
  }

  private changed(): void {
    this.deps.onChange(this.snapshot());
  }
}
