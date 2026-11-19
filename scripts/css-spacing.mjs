/**
 * Reads a stylesheet for scripts/check-spacing.mjs: padding, margin and gap values written as
 * raw lengths instead of `--space-*` tokens, and selectors given more than one top-level block.
 */

const SPACING = /^(padding|margin)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$|^(row-|column-)?gap$/;

/** A raw length in a spacing value. `0` and a 1px hairline offset are allowed. */
const LENGTH = /(^|[^\w-])(-?\d*\.?\d+)(px|rem|em)\b/g;

/**
 * @param {string} value
 * @returns {string[]} raw lengths, e.g. ['6px', '14px']
 */
export function rawLengths(value) {
  const bare = value.replace(/var\([^()]*(\([^()]*\)[^()]*)*\)/g, '');
  const found = [];
  for (const match of bare.matchAll(LENGTH)) {
    const [, , number, unit] = match;
    if (Number(number) === 0) continue;
    if (unit === 'px' && Math.abs(Number(number)) === 1) continue;
    found.push(`${number}${unit}`);
  }
  return found;
}

/**
 * @param {string} css
 * @returns {{
 *   spacing: Array<{ line: number; property: string; value: string; raw: string[] }>;
 *   duplicates: Array<{ selector: string; lines: number[] }>;
 * }}
 */
export function scanCss(css) {
  // Comments become spaces of the same length so line numbers survive.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  /** @type {Array<{ prelude: string; rule: boolean }>} */
  const stack = [];
  const spacing = [];
  /** @type {Map<string, { selector: string; lines: number[] }>} */
  const blocks = new Map();
  let buffer = '';
  let start = 1;
  let line = 1;

  const declaration = () => {
    const top = stack[stack.length - 1];
    const colon = buffer.indexOf(':');
    if (!top?.rule || colon < 0) return;
    const property = buffer.slice(0, colon).trim().toLowerCase();
    if (!SPACING.test(property)) return;
    const value = buffer.slice(colon + 1).trim();
    const raw = rawLengths(value);
    if (raw.length > 0) spacing.push({ line: start, property, value, raw });
  };

  for (const char of text) {
    if (buffer.trim() === '' && char !== '\n') start = line;
    if (char === '{') {
      const prelude = buffer.trim().replace(/\s+/g, ' ');
      const rule = !prelude.startsWith('@');
      // Only blocks outside other rules count; the same selector under @media is an override.
      if (rule && stack.every((frame) => !frame.rule) && stack.every((frame) => !/^@(media|supports|container)/.test(frame.prelude))) {
        const context = stack.map((frame) => frame.prelude).join(' ');
        const key = `${context}\u0000${prelude}`;
        const entry = blocks.get(key) ?? { selector: context ? `${context} ${prelude}` : prelude, lines: [] };
        entry.lines.push(start);
        blocks.set(key, entry);
      }
      stack.push({ prelude, rule });
      buffer = '';
    } else if (char === '}') {
      declaration();
      stack.pop();
      buffer = '';
    } else if (char === ';') {
      declaration();
      buffer = '';
    } else {
      buffer += char;
    }
    if (char === '\n') line += 1;
  }

  const duplicates = [...blocks.values()].filter((entry) => entry.lines.length > 1);
  return { spacing, duplicates };
}
