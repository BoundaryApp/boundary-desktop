/** Writing voices (ADR 0056): a voice calibrated from samples of someone's writing. */

/** A sample the person added: a file on this Mac, or text pasted into the create sheet. */
export type WritingVoiceSource = { kind: 'file'; path: string } | { kind: 'pasted'; text: string };

/** Why a sample isn't used. */
export type WritingVoiceRefusal = 'type' | 'empty' | 'too-large' | 'unreadable' | 'folder';

export interface WritingVoiceSampleCheck {
  /** File name, or "Pasted text N" (1-based, in source order among pasted entries). */
  label: string;
  source: WritingVoiceSource;
  words: number;
  listHeavy: boolean;
  refused: WritingVoiceRefusal | null;
  /** For a refused type: the extension upper-cased without the dot, e.g. "PDF". */
  extension?: string;
}

export interface WritingVoiceCheckSummary {
  files: WritingVoiceSampleCheck[];
  /** Samples that will be used. */
  pieces: number;
  words: number;
  /** Used samples of 500 words or more. */
  longPieces: number;
  /** Used samples that are mostly headers and lists. */
  listHeavy: number;
  /** Five or more long pieces. */
  enough: boolean;
}

export type WritingVoiceStatus = 'not-calibrated' | 'calibrating' | 'ready';

export interface WritingVoiceRecord {
  id: string;
  name: string;
  status: WritingVoiceStatus;
  pieces: number;
  words: number;
  createdAt: string;
  calibratedAt: string | null;
  /** sha256 of the sorted "relative path\tsize" lines of samples/. */
  sampleHash: string;
  /** Stored ids of the hidden sessions calibration ran in, kept out of the chat list. */
  calibrationSessionIds?: string[];
  /** Why the last calibration didn't finish; null after a good one. */
  lastError?: string | null;
}

export type WritingVoiceStep = 'waiting' | 'starting' | 'reading' | 'writing' | 'checking';

export interface WritingVoiceProgress {
  id: string;
  status: WritingVoiceStatus;
  step: WritingVoiceStep | null;
  lastError: string | null;
}

export interface WritingVoiceCreatePayload {
  name: string;
  sources: WritingVoiceSource[];
}

export type WritingVoiceCreateResult =
  | { success: true; voice: WritingVoiceRecord }
  | { success: false; error: string };

/** A voice as Settings shows it: the record plus what main reads from its folder. */
export interface WritingVoiceView extends WritingVoiceRecord {
  style: WritingVoiceStyle | null;
  /** Ready, but the samples differ from the ones calibration read. */
  samplesChanged: boolean;
  /** The calibration step, while one runs in this process. */
  step: WritingVoiceStep | null;
}

export type WritingVoiceListResult =
  | { success: true; voices: WritingVoiceView[] }
  | { success: false; error: string };

export type WritingVoiceViewResult =
  | { success: true; voice: WritingVoiceView }
  | { success: false; error: string };

export type WritingVoiceSamplesResult =
  | { success: true; files: Array<{ name: string; words: number }> }
  | { success: false; error: string };

export type WritingVoiceActionResult = { success: true } | { success: false; error: string };

export type WritingVoicePickResult = { canceled: true } | { canceled: false; paths: string[] };

/** What Boundary reads from a voice's STYLE.md (written by calibration, editable by hand). */
export interface WritingVoiceStyle {
  /** The first paragraph after the "# Voice:" title; '' when there is none. */
  description: string;
  /** Bullets under "## Never does", without the template's "Never <...>" placeholders. */
  neverDoes: string[];
  /** The frontmatter's exemplar paths, relative to the voice folder, as written. */
  exemplars: string[];
  /** STYLE.md's length in characters. */
  chars: number;
  /** The frontmatter's `calibrated` date, as written. */
  calibrated: string | null;
}

/** An agent's two voice settings (ADR 0056 §5); null is No voice. */
export interface AgentWritingVoices {
  chatRepliesVoiceId: string | null;
  draftsVoiceId: string | null;
}

/** An agent that uses a voice, and for which setting. */
export interface WritingVoiceUser {
  slug: string;
  displayName: string;
  uses: Array<'chat-replies' | 'drafts'>;
}

export type WritingVoiceUsersResult =
  | { success: true; agents: WritingVoiceUser[]; /** Chats that keep the voice. */ chats: number }
  | { success: false; error: string };
