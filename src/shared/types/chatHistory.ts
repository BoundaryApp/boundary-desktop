/** Moving chat history between installs (ADR 0070). The renderer sees counts and paths only. */

/** One Hermes profile's share of an export, from `sessions.sh export`'s `profile` line. */
export interface ChatHistoryProfileCount {
  /** The Hermes profile: `default` for the built-in agent and rooms, else an agent's slug. */
  profile: string;
  /** The agent's name for the profile, when Boundary has a record of it. */
  label: string | null;
  sessions: number;
  messages: number;
}

/** Where the one history action stands. Main keeps the latest and sends each change. */
export type ChatHistoryState =
  | { phase: 'idle' }
  | { phase: 'exporting'; folder: string; profiles: ChatHistoryProfileCount[]; cancelling: boolean }
  | { phase: 'exported'; folder: string; profiles: ChatHistoryProfileCount[]; sessions: number; messages: number }
  | { phase: 'cancelled' }
  | { phase: 'failed'; error: string };

export interface ChatHistoryStatus {
  state: ChatHistoryState;
  /**
   * Why both actions are unavailable on this stack host (ADR 0070 §13), or null when they
   * aren't refused for that reason.
   */
  unavailable: string | null;
}

/** `started` is false when the folder dialog was closed without a choice. */
export type ChatHistoryExportStart =
  | { success: true; started: boolean }
  | { success: false; error: string };
