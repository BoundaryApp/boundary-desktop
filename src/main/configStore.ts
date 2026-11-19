import Store from 'electron-store';

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

/** Size of the main window on first launch, centred on the primary display. */
export const DEFAULT_WINDOW_BOUNDS: WindowBounds = { width: 1800, height: 1250 };

/** Every key main reads or writes in `boundary-config`. */
export interface BoundaryConfig {
  /** Appearance: system | light | dark. */
  themePreference: string;
  windowBounds: WindowBounds;
  /** macOS: the display the main window was last on, so it reopens there. */
  lastDisplayId?: number;
  /** The newest app version that has run against this data. */
  dataVersion?: string;
  /** The desktop button switch (ADR 0058). */
  desktopAgentButton?: boolean;
  /** Plaintext secrets kept by older builds. Deleted at launch; nothing reads them. */
  apiKey?: unknown;
  secretToken?: unknown;
  databaseUrl?: unknown;
}

export type ConfigStore = Store<BoundaryConfig>;

export function createConfigStore(): ConfigStore {
  return new Store<BoundaryConfig>({
    name: 'boundary-config',
    defaults: { themePreference: 'system', windowBounds: DEFAULT_WINDOW_BOUNDS },
  });
}
