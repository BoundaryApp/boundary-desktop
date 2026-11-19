/**
 * **Keep the agent button on the desktop** (ADR 0058 §17). On, the built-in agent's button and
 * panel float over every app and closing the window hides it. macOS only (§16). It starts on in
 * builds made for testing and off in release builds until it has been tried there.
 */

/** The part of Boundary's config store that holds the switch. Unset means the build's default. */
export interface DesktopAgentStore {
  get(key: 'desktopAgentButton'): unknown;
  set(key: 'desktopAgentButton', value: boolean): void;
}

export interface DesktopAgentBuild {
  isPackaged: boolean;
  /** A build meant to install beside the default one (`IS_SEPARATE_INSTANCE`). */
  isSeparateInstance: boolean;
}

export function desktopAgentDefault(build: DesktopAgentBuild): boolean {
  return !build.isPackaged || build.isSeparateInstance;
}

export function isDesktopAgentOn(store: DesktopAgentStore, platform: NodeJS.Platform, build: DesktopAgentBuild): boolean {
  if (platform !== 'darwin') return false;
  const stored = store.get('desktopAgentButton');
  return typeof stored === 'boolean' ? stored : desktopAgentDefault(build);
}

/** What Settings shows: whether the switch exists on this platform, and its position. */
export function desktopAgentState(
  store: DesktopAgentStore,
  platform: NodeJS.Platform,
  build: DesktopAgentBuild
): { available: boolean; on: boolean } {
  return { available: platform === 'darwin', on: isDesktopAgentOn(store, platform, build) };
}

const listeners = new Set<(on: boolean) => void>();

/** Hear the switch change. Returns a function that stops. */
export function onDesktopAgentChange(handler: (on: boolean) => void): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/** Store the switch and tell listeners when its position changed. Does nothing off macOS. */
export function setDesktopAgentOn(
  store: DesktopAgentStore,
  platform: NodeJS.Platform,
  build: DesktopAgentBuild,
  on: boolean
): void {
  if (platform !== 'darwin') return;
  const was = isDesktopAgentOn(store, platform, build);
  store.set('desktopAgentButton', on);
  if (was !== on) for (const listener of listeners) listener(on);
}

export function resetDesktopAgentListenersForTests(): void {
  listeners.clear();
}
