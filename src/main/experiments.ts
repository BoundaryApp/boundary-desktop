/**
 * Private experiments (one folder each under ../experiments, absent from the public repository)
 * join main-process startup here.
 */
export interface MainExperiment {
  /** Registers IPC handlers and hooks. Runs once, before app ready, after the app's own handlers. */
  register?(): void;
  /** Runs after app ready and before the main window opens. A rejection stops startup. */
  startBeforeWindow?(): Promise<void>;
  /** Runs once on quit, before Circles and the assistant stack stop. A rejection is logged and quit goes on. */
  stop?(): Promise<void>;
}

const modules = import.meta.glob<{ default: MainExperiment }>('../experiments/*/main.ts', {
  eager: true,
});

const experiments: MainExperiment[] = Object.values(modules).map((module) => module.default);

export function registerExperiments(): void {
  for (const experiment of experiments) {
    experiment.register?.();
  }
}

export async function startExperimentsBeforeWindow(): Promise<void> {
  for (const experiment of experiments) {
    await experiment.startBeforeWindow?.();
  }
}

/** Runs every experiment's `stop`, all at once. Never rejects. */
export async function stopExperiments(): Promise<void> {
  await Promise.allSettled(experiments.map(async (experiment) => experiment.stop?.()));
}
