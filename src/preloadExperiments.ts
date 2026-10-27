/**
 * Private experiments (one folder each under ../experiments, absent from the public repository)
 * add namespaces to window.electronAPI here. Each declares its namespaces' types by merging them
 * into ExperimentBridges.
 */
export interface PreloadExperiment {
  bridge: Partial<ExperimentBridges>;
}

const modules = import.meta.glob<{ default: PreloadExperiment }>('./experiments/*/preload.ts', {
  eager: true,
});

/** Every experiment's bridge namespaces, merged into one object. */
export function experimentBridges(): Partial<ExperimentBridges> {
  return Object.assign({}, ...Object.values(modules).map((module) => module.default.bridge));
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- experiments add members by declaration merging
  interface ExperimentBridges {}
}
