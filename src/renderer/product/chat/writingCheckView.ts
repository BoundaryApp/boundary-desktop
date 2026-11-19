/**
 * Writing check results shaped for the inspector (writing check spec, phase 2): a cached
 * check per text, and the checked prose split into runs that share the same flags.
 */

import { checkText, type CheckResult } from '../../../shared/writingCheck/checkText';
import { extractProse } from '../../../shared/writingCheck/prose';
import type { DetectorSegment } from '../../../shared/types/writingCheck';

/** A detector segment at or above this score is underlined in the pane. */
export const DETECTED_SCORE = 0.5;

/** Results for the texts checked in this window, newest last. Memory only. */
const cache = new Map<string, CheckResult>();
const CACHE_SIZE = 20;

/** The check for `markdown`, reusing the last result for the same text and rule set. */
export function cachedCheck(markdown: string): CheckResult {
  const hit = cache.get(markdown);
  if (hit) {
    cache.delete(markdown);
    cache.set(markdown, hit);
    return hit;
  }
  const result = checkText(markdown);
  cache.set(markdown, result);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return result;
}

interface Run {
  text: string;
  /** Indexes into `result.flags`; empty for unflagged text. */
  flags: number[];
  /** Inside a detector segment that scored DETECTED_SCORE or more. */
  detected: boolean;
}

export interface CheckedBlock {
  kind: 'paragraph' | 'heading' | 'listItem';
  runs: Run[];
}

/**
 * The checked prose block by block, each split wherever the set of covering flags, or whether a
 * high detector segment covers it, changes. Segment offsets are into `markdown`, as flags' are.
 */
export function checkedBlocks(
  markdown: string,
  result: CheckResult,
  segments: readonly DetectorSegment[] = []
): CheckedBlock[] {
  const high = segments.filter((segment) => segment.score >= DETECTED_SCORE);
  return extractProse(markdown).blocks.map((block) => {
    const runs: Run[] = [];
    block.map.forEach((at, i) => {
      const flags = result.flags.flatMap((flag, index) => (at >= flag.start && at < flag.end ? [index] : []));
      const detected = high.some((segment) => at >= segment.start && at < segment.end);
      const last = runs[runs.length - 1];
      if (last && last.detected === detected && last.flags.join() === flags.join()) last.text += block.text[i];
      else runs.push({ text: block.text[i], flags, detected });
    });
    return { kind: block.kind, runs };
  });
}
