import type { IpcResult } from '../ipc/result';

/** File types the writing check reads (writing check spec, phase 4). */
export const WRITING_CHECK_FILE_EXTENSIONS = ['.md', '.markdown', '.txt'] as const;

export interface WritingCheckFilePayload {
  projectId: string;
  /** Relative to the project's host folder. */
  relativePath: string;
}

export interface WritingCheckPickPayload {
  projectId: string;
}

export type WritingCheckFileResult = IpcResult<{
  canceled?: boolean;
  file?: { relativePath: string; text: string; modifiedAt: string };
}>;

export function isCheckableFile(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return WRITING_CHECK_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Detector add-on providers (stack v0.3.14, CR 0030). Scores aren't comparable across them. */
export type DetectorProvider = 'pangram' | 'gptzero';

export const DETECTOR_PROVIDER_NAMES: Record<DetectorProvider, string> = {
  pangram: 'Pangram',
  gptzero: 'GPTZero',
};

/** Whether the pane can offer a detector score, and what it must say before the first one. */
export type DetectorStatus =
  | { available: false }
  | { available: true; provider: DetectorProvider; dataLeaves: string; consented: boolean };

export interface DetectorSegment {
  /** UTF-16 offsets into the checked text, half-open. */
  start: number;
  end: number;
  score: number;
}

export interface DetectorScore {
  provider: DetectorProvider;
  /** The provider's own number, 0–1. */
  score: number;
  label?: string;
  model?: string;
  segments: DetectorSegment[];
  checkedAt: string;
}

/** The add-on's codes, plus `unavailable` when nothing answers on its port. */
export type DetectorErrorCode =
  | 'too_short'
  | 'too_long'
  | 'no_key'
  | 'quota'
  | 'provider_error'
  | 'timeout'
  | 'bad_input'
  | 'unauthorized'
  | 'forbidden'
  | 'unavailable';

export type DetectorCheckResult =
  | { ok: true; score: DetectorScore }
  | { ok: false; error: { code: DetectorErrorCode; message: string; retryAfter?: number } };

/** The add-on refuses under 50 words, split on whitespace, before calling the provider. */
export const DETECTOR_MIN_WORDS = 50;

export function detectorWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
