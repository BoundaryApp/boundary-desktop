/**
 * The writing check (writing check spec, phase 1): markdown in, flags out.
 *
 * Flags point at features common in model output. They are not a judgement of where the text
 * came from, so the result carries a count and a density, never a probability.
 */

import { extractProse } from './prose';
import { RULES, RULE_SET_VERSION, countWords, type Category } from './rules';

export interface Flag {
  rule: string;
  /** The humanizer skill's pattern number, when it has one. */
  pattern?: number;
  category: Category;
  title: string;
  reason: string;
  /** Source offsets into the checked markdown. */
  start: number;
  end: number;
}

export interface CheckResult {
  ruleSetVersion: number;
  words: number;
  flags: Flag[];
  /** Flags per 100 words; null under MIN_WORDS, where a density means little. */
  perHundredWords: number | null;
}

const MIN_WORDS = 50;

export function checkText(markdown: string): CheckResult {
  const { blocks } = extractProse(markdown);
  const words = blocks.reduce((n, block) => n + countWords(block.text), 0);
  const flags: Flag[] = [];
  for (const rule of RULES) {
    const seen = new Set<string>();
    for (const span of rule.find(blocks)) {
      const key = `${span.start}:${span.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flags.push({
        rule: rule.id,
        ...(rule.pattern !== undefined ? { pattern: rule.pattern } : {}),
        category: rule.category,
        title: rule.title,
        reason: rule.reason,
        start: span.start,
        end: span.end,
      });
    }
  }
  flags.sort((a, b) => a.start - b.start || a.end - b.end);
  return {
    ruleSetVersion: RULE_SET_VERSION,
    words,
    flags,
    perHundredWords: words >= MIN_WORDS ? (flags.length * 100) / words : null,
  };
}
