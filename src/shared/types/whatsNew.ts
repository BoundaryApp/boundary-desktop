/** What the renderer knows about this launch and what has been read (ADR 0059). */
export interface WhatsNewSnapshot {
  /** The version running now. */
  currentVersion: string;
  /**
   * The version this install last caught up from: `unknown` for an install that predates release
   * notes, null for one that has only ever run this version. It stays put once the notes are
   * read, so the page can still say which releases are new to this install.
   */
  upgradedFrom: string | null;
  /** Nothing ran here before, so there is nothing to catch up on. */
  firstInstall: boolean;
  /** Versions whose notes have been seen. */
  seen: string[];
  /** A new release opens its notes by itself. */
  popups: boolean;
}
