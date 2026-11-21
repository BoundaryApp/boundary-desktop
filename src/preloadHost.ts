/**
 * Host API: IPC for features' preload bridges. Re-exports only. Kept apart from
 * preloadExperiments.ts, which loads every experiment's preload file: a runtime import of it from
 * one of those files would be circular.
 */
export { invoker, listen } from './preloadIpc';
