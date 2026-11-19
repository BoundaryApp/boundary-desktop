import { compareVersions } from '../updates/updateFeed';
import type { WhatsNewSnapshot } from '../../../shared/types/whatsNew';

export interface WhatsNewStoreShape {
  /** The version that last reached a launch here. */
  lastRunVersion: string;
  /** Versions whose notes have been seen. */
  seen: string[];
  /** False once someone turns the popup off. */
  popups: boolean;
  /** The version an unseen upgrade came from, or `unknown`. Cleared when the notes are seen. */
  upgradedFrom: string;
}

export interface WhatsNewStore {
  get<K extends keyof WhatsNewStoreShape>(key: K): WhatsNewStoreShape[K] | undefined;
  set<K extends keyof WhatsNewStoreShape>(key: K, value: WhatsNewStoreShape[K]): void;
}

interface WhatsNewDeps {
  currentVersion: string;
  /** Setup finished at some point, so this install has been used before. */
  setupComplete: () => boolean;
  store: WhatsNewStore;
  /** Closes the updater's own "What's new" card, which the notes replace. */
  closeUpdated?: () => void;
  onChange?: (snapshot: WhatsNewSnapshot) => void;
}

/**
 * Works out what this launch is: a first install, an upgrade whose notes are still unread, or
 * neither (ADR 0059). An upgrade stays pending until its notes are seen, so a start-up that
 * failed or was quit early doesn't lose them.
 */
export class WhatsNewService {
  private readonly firstInstall: boolean;

  constructor(private readonly deps: WhatsNewDeps) {
    const { store, currentVersion } = deps;
    const lastRun = store.get('lastRunVersion');
    this.firstInstall = !lastRun && !deps.setupComplete();

    if (this.firstInstall) {
      // Nothing ran here before: changes since a version they never had mean nothing.
      store.set('seen', this.withSeen(currentVersion));
    } else if (!lastRun) {
      store.set('upgradedFrom', 'unknown');
    } else if ((compareVersions(currentVersion, lastRun) ?? 0) > 0) {
      // Where to catch up from: the version last run, unless its own notes were never read, in
      // which case the older pending upgrade still has releases to show.
      const pending = store.get('upgradedFrom');
      const lastRunUnread = !this.seen().includes(lastRun);
      store.set('upgradedFrom', pending && lastRunUnread ? pending : lastRun);
    }
    store.set('lastRunVersion', currentVersion);
  }

  snapshot(): WhatsNewSnapshot {
    const seen = this.seen();
    return {
      currentVersion: this.deps.currentVersion,
      upgradedFrom: this.deps.store.get('upgradedFrom') ?? null,
      firstInstall: this.firstInstall,
      seen,
      popups: this.deps.store.get('popups') ?? true,
    };
  }

  markSeen(version: string): void {
    this.deps.store.set('seen', this.withSeen(version));
    if (version === this.deps.currentVersion) this.deps.closeUpdated?.();
    this.changed();
  }

  setPopups(on: boolean): void {
    this.deps.store.set('popups', on);
    this.changed();
  }

  private seen(): string[] {
    return this.deps.store.get('seen') ?? [];
  }

  private withSeen(version: string): string[] {
    const seen = this.seen();
    return seen.includes(version) ? seen : [...seen, version];
  }

  private changed(): void {
    this.deps.onChange?.(this.snapshot());
  }
}
