/** How the user left an optional setup step. */
export type OptionalSetupOutcome = 'done' | 'skipped';

/** A project picked in the setup flow's Folders step, created once the stack is up. */
export type FirstRunFolder =
  | { kind: 'host-folder'; hostPath: string }
  | { kind: 'empty'; name: string };

export interface SetupProgress {
  /** Setup had already finished when this version first ran (written once, on upgrade). */
  completedBeforeOptionalSteps: boolean;
  /** Boundary had projects at that moment. Upgraders without any still see the Folders step. */
  hadProjectsBeforeOptionalSteps: boolean;
  /** Outcome per optional step id. A missing entry means the step hasn't been answered. */
  outcomes: Record<string, OptionalSetupOutcome>;
  /** Folders step picks not yet created as projects. */
  pendingFolders: FirstRunFolder[];
}

/** A folder from the Folders step's picker, judged against ADR 0028 §5. */
export interface FirstRunFolderPick {
  hostPath: string;
  name: string;
  /** `~/…` form for display. */
  displayPath: string;
  /** Why the folder can't be used, or null when it can. */
  refuseMessage: string | null;
}

export interface PickFirstRunFoldersResult {
  canceled?: boolean;
  folders: FirstRunFolderPick[];
}

export interface SaveFirstRunFoldersResult {
  success: boolean;
  error?: string;
  progress: SetupProgress;
}

export interface ApplyFirstRunFoldersResult {
  success: boolean;
  /** The per-project error the chat shows when creating a project failed. */
  error?: string;
  activeId?: string | null;
  progress: SetupProgress;
}
