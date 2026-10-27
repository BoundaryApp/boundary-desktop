import Store from 'electron-store';
import type {
  FirstRunFolder,
  OptionalSetupOutcome,
  SetupProgress,
} from '../../../shared/types/setupProgress';

interface SetupProgressStoreShape {
  /** Whether the upgrade facts below have been written. They are written once. */
  historyRecorded: boolean;
  completedBeforeOptionalSteps: boolean;
  hadProjectsBeforeOptionalSteps: boolean;
  outcomes: Record<string, OptionalSetupOutcome>;
  pendingFolders: FirstRunFolder[];
}

const DEFAULTS: SetupProgressStoreShape = {
  historyRecorded: false,
  completedBeforeOptionalSteps: false,
  hadProjectsBeforeOptionalSteps: false,
  outcomes: {},
  pendingFolders: [],
};

const store = new Store<SetupProgressStoreShape>({
  name: 'setup-progress',
  defaults: { ...DEFAULTS },
});

/**
 * On the first launch of a version with optional setup steps, note whether setup had already
 * finished and whether any project existed. Later launches leave both as they were, so
 * finishing setup in this version never marks the user as upgraded. Called by the
 * setup-history migration (src/main/migrations).
 */
export function recordSetupHistoryOnce(facts: {
  setupComplete: boolean;
  hasProjects: boolean;
}): void {
  if (store.get('historyRecorded')) return;
  store.set('completedBeforeOptionalSteps', facts.setupComplete);
  store.set('hadProjectsBeforeOptionalSteps', facts.setupComplete && facts.hasProjects);
  store.set('historyRecorded', true);
}

export function getSetupProgress(): SetupProgress {
  return {
    completedBeforeOptionalSteps: Boolean(store.get('completedBeforeOptionalSteps')),
    hadProjectsBeforeOptionalSteps: Boolean(store.get('hadProjectsBeforeOptionalSteps')),
    outcomes: { ...(store.get('outcomes') ?? {}) },
    pendingFolders: [...(store.get('pendingFolders') ?? [])],
  };
}

export function recordOptionalStepOutcome(stepId: string, outcome: OptionalSetupOutcome): void {
  store.set('outcomes', { ...(store.get('outcomes') ?? {}), [stepId]: outcome });
}

export function setPendingFirstRunFolders(folders: FirstRunFolder[]): void {
  store.set('pendingFolders', folders);
}

export function resetSetupProgressStoreForTests(): void {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    store.set(key as keyof SetupProgressStoreShape, structuredClone(value));
  }
}
