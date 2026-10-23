export type RuntimeDiagnosticsMachineStatus =
  | 'missing'
  | 'stopped'
  | 'running'
  | 'unknown'
  | null;

/**
 * Snapshot of the active container engine for Settings diagnostics / DMG verification.
 * Safe to copy to clipboard (no secrets).
 */
export type ContainerRuntimeDiagnostics = {
  available: boolean;
  checkedAt: string;
  error?: string;
  kind?: 'docker' | 'podman';
  origin?: 'system' | 'bundled';
  /** Human-readable engine name for UI. */
  engineLabel: string;
  cliVersion?: string;
  composeVersion?: string | null;
  apiEndpoint?: string;
  /** Shortened endpoint for display. */
  apiEndpointDisplay?: string;
  machineName?: string | null;
  machineStatus?: RuntimeDiagnosticsMachineStatus;
  assetsPresent?: boolean | null;
  podmanBinaryPresent?: boolean | null;
  composeBinaryPresent?: boolean | null;
  stateDir?: string | null;
  provisionProgress?: string | null;
  /**
   * What the system Docker probe found on the last resolve, so a machine that took the
   * bundled Podman path shows why. Null before the first probe or when it was skipped.
   */
  systemDocker?: {
    endpoint: string | null;
    endpointSource: 'DOCKER_HOST' | 'context' | 'socket' | null;
    context: string | null;
    attempts: { endpoint: string; ok: boolean; error?: string }[];
    cliPath: string | null;
    loginShellPathRead: boolean;
  } | null;
};

export type GetRuntimeDiagnosticsInput = {
  /** When true, clear the runtime cache and re-resolve (Docker ↔ bundled). */
  refresh?: boolean;
};
