import type {
  RunningWorkItem,
  UpdateBlock,
  UpdateChannel,
  UpdatePhase,
  UpdateRestartResult,
  UpdateSnapshot,
} from '../../../shared/types/updates';
import {
  compareVersions,
  defaultChannel,
  feedUrl,
  parseFeed,
  type UpdateOffer,
} from './updateFeed';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const WORK_POLL_MS = 15_000;

export interface UpdateStoreShape {
  channel?: UpdateChannel;
  checksEnabled?: boolean;
  lastCheckedAt?: string;
  skippedVersion?: string;
  /** `<version>:<stage>` of the last notice the user closed. */
  closedNotice?: string;
  /** The version whose dot the Updates tab cleared. */
  pageSeenVersion?: string;
}

export interface UpdateStore {
  get<K extends keyof UpdateStoreShape>(key: K): UpdateStoreShape[K];
  set<K extends keyof UpdateStoreShape>(key: K, value: NonNullable<UpdateStoreShape[K]>): void;
}

/** The part of Electron's autoUpdater this service uses. */
export interface SquirrelUpdater {
  setFeedURL(options: { url: string; serverType: 'json' }): void;
  checkForUpdates(): void;
  on(event: 'update-downloaded' | 'update-not-available', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface UpdateServiceDeps {
  currentVersion: string;
  arch: string;
  /** Empty when the build has no feed, as in dev builds and forks. */
  feedBase: string;
  inApplications: () => boolean;
  fetchText: (url: string) => Promise<string>;
  updater: SquirrelUpdater;
  store: UpdateStore;
  runningWork: () => Promise<RunningWorkItem[]>;
  /** Stop the stack the way a quit does, then hand over to Squirrel. */
  installAndRestart: () => void;
  onChange: (snapshot: UpdateSnapshot) => void;
  log: (message: string, details?: Record<string, unknown>) => void;
}

/** Offers, downloads and installs app updates. Nothing downloads until the user says so. */
export class UpdateService {
  private offer: UpdateOffer | null = null;
  private phase: UpdatePhase = 'idle';
  private checking = false;
  private error: UpdateSnapshot['error'] = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private waitTimer: ReturnType<typeof setInterval> | null = null;
  private waitingFor = new Set<string>();

  constructor(private readonly deps: UpdateServiceDeps) {
    deps.updater.on('update-downloaded', () => {
      if (this.phase !== 'downloading') return;
      this.phase = 'ready';
      this.changed();
    });
    deps.updater.on('update-not-available', () => this.downloadFailed('update-not-available'));
    deps.updater.on('error', (error) => this.downloadFailed(error.name));
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
      summary: version ? (this.offer?.summary ?? '') : '',
      checking: this.checking,
      lastCheckedAt: store.get('lastCheckedAt') ?? null,
      error: this.error,
      showNotice:
        version !== null && store.get('closedNotice') !== `${version}:${this.noticeStage()}`,
      showDot: version !== null && store.get('pageSeenVersion') !== version,
      waitingFor: this.waitingFor.size,
    };
  }

  /** A manual check also clears a skip, so a skipped version can be taken after all. */
  async check(options: { manual: boolean }): Promise<UpdateSnapshot> {
    if (this.blocked() !== 'none' || this.checking) return this.snapshot();
    if (this.phase === 'downloading' || this.phase === 'ready') return this.snapshot();
    const { store, fetchText, currentVersion, arch, feedBase } = this.deps;
    this.checking = true;
    this.error = null;
    this.changed();
    try {
      const offer = parseFeed(await fetchText(feedUrl(feedBase, this.channel(), arch)));
      if (!offer) throw new Error('Unreadable feed');
      store.set('lastCheckedAt', new Date().toISOString());
      if (options.manual && store.get('skippedVersion') === offer.version) {
        store.set('skippedVersion', '');
      }
      const newer = (compareVersions(offer.version, currentVersion) ?? 0) > 0;
      const wanted = newer && store.get('skippedVersion') !== offer.version;
      this.offer = wanted ? offer : null;
      this.phase = wanted ? 'available' : 'idle';
    } catch (error) {
      this.error = 'check';
      this.deps.log('update check failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      this.checking = false;
      this.changed();
    }
    return this.snapshot();
  }

  download(): UpdateSnapshot {
    if (this.phase !== 'available') return this.snapshot();
    const { updater, feedBase, arch } = this.deps;
    this.phase = 'downloading';
    this.error = null;
    try {
      updater.setFeedURL({ url: feedUrl(feedBase, this.channel(), arch), serverType: 'json' });
      updater.checkForUpdates();
    } catch (error) {
      this.downloadFailed(error instanceof Error ? error.name : typeof error);
      return this.snapshot();
    }
    this.changed();
    return this.snapshot();
  }

  /** Restarts now when nothing is running or `force` is set; otherwise says what is running. */
  async restart(options: { force: boolean }): Promise<UpdateRestartResult> {
    if (this.phase !== 'ready') return { status: 'not-ready' };
    if (!options.force) {
      const items = await this.deps.runningWork();
      if (items.length > 0) return { status: 'work-running', items };
    }
    this.stopWaiting();
    this.deps.installAndRestart();
    return { status: 'restarting' };
  }

  /** Wait for the listed work only. Work started later doesn't postpone the restart. */
  restartWhenFinished(items: RunningWorkItem[]): void {
    if (this.phase !== 'ready') return;
    this.waitingFor = new Set(items.map((item) => item.id));
    this.waitTimer ??= setInterval(() => void this.pollWork(), WORK_POLL_MS);
    this.changed();
  }

  cancelWaiting(): void {
    this.stopWaiting();
    this.changed();
  }

  closeNotice(): void {
    const { version } = this.snapshot();
    if (version) this.deps.store.set('closedNotice', `${version}:${this.noticeStage()}`);
    this.changed();
  }

  skipVersion(): void {
    if (this.phase !== 'available' || !this.offer) return;
    this.deps.store.set('skippedVersion', this.offer.version);
    this.offer = null;
    this.phase = 'idle';
    this.changed();
  }

  markPageSeen(): void {
    const { version } = this.snapshot();
    if (version) this.deps.store.set('pageSeenVersion', version);
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

  private blocked(): UpdateBlock {
    if (!this.deps.feedBase) return 'no-feed';
    return this.deps.inApplications() ? 'none' : 'not-in-applications';
  }

  /** A closed notice stays closed through a download, and returns once the update is ready. */
  private noticeStage(): 'ask' | 'ready' {
    return this.phase === 'ready' ? 'ready' : 'ask';
  }

  private async scheduledCheck(): Promise<void> {
    if (this.deps.store.get('checksEnabled') ?? true) await this.check({ manual: false });
  }

  private downloadFailed(reason: string): void {
    if (this.phase !== 'downloading') return;
    this.deps.log('update download failed', { reason });
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
    for (const id of this.waitingFor) if (!running.has(id)) this.waitingFor.delete(id);
    if (this.waitingFor.size === 0) {
      this.stopWaiting();
      this.deps.installAndRestart();
      return;
    }
    this.changed();
  }

  private stopWaiting(): void {
    if (this.waitTimer) clearInterval(this.waitTimer);
    this.waitTimer = null;
    this.waitingFor.clear();
  }

  private changed(): void {
    this.deps.onChange(this.snapshot());
  }
}
