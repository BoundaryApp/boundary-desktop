import { existsSync, readFileSync } from 'node:fs';
import { attributes, children, sources } from './jsxScan';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// An icon button written by hand as a `<button>` whose children are only an icon or a glyph,
// instead of Button with size="icon", "icon-sm" or "icon-xs" (ADR 0061). Only the files in
// OWN_CONTROL may have any, and no more than their count. assistant-ui's action and version
// buttons render their own `<button>`, so they aren't tags this scan sees; the last test
// requires each to wrap a Button with asChild.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const renderer = join(root, 'src/renderer');
const ui = join(renderer, 'components/ui');

/**
 * What a button's children show: the text in its JSX, including text inside elements and inside
 * JSX held by `{…}` expressions, with whether it shows anything at all (an icon counts). `text` is
 * null when an expression with no JSX may be text (`{label}`).
 */
function shown(inner: string): { text: string | null; content: boolean } {
  let text: string | null = '';
  let content = false;
  const add = (more: string) => {
    if (text !== null) text += more;
  };

  /** JSX children from `i` up to a closing tag or the end; returns the index after the closing tag. */
  const children = (i: number): number => {
    while (i < inner.length) {
      if (inner.startsWith('</', i)) return inner.indexOf('>', i) + 1;
      if (inner[i] === '<' && /[A-Za-z]/.test(inner[i + 1] ?? '')) i = element(i);
      else if (inner[i] === '{') i = expression(i);
      else {
        if (/\S/.test(inner[i])) content = true;
        add(inner[i]);
        i += 1;
      }
    }
    return i;
  };

  const element = (i: number): number => {
    content = true;
    const attrs = attributes(inner, i + 1);
    const after = i + 1 + attrs.length + 1;
    return attrs.trimEnd().endsWith('/') ? after : children(after);
  };

  /** A `{…}` from `i`; returns the index after its `}`. */
  const expression = (i: number): number => {
    let depth = 0;
    let quote = '';
    let jsx = false;
    let j = i;
    for (; j < inner.length; j += 1) {
      const char = inner[j];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) break;
      } else if (char === '<' && /[A-Za-z]/.test(inner[j + 1] ?? '')) {
        jsx = true;
        j = element(j) - 1;
      }
    }
    const expr = inner.slice(i + 1, j).trim();
    const literal = /^(['"`])([^'"`]*)\1$/.exec(expr);
    if (literal) add(literal[2]);
    else if (!jsx && expr && !expr.startsWith('/*')) text = null;
    return j + 1;
  };

  children(0);
  return { text: text === null ? null : text.replace(/\s+/g, ''), content };
}

/** `<button>` tags whose children are icons, or one or two glyph characters, named or not. */
function countRaw(source: string): number {
  let count = 0;
  for (const match of source.matchAll(/<button\b/g)) {
    const start = match.index + match[0].length;
    const attrs = attributes(source, start);
    const { text, content } = shown(children(source, 'button', start + attrs.length));
    if (content && text !== null && /^[^\p{L}\p{N}]{0,2}$/u.test(text)) count += 1;
  }
  return count;
}

/** Icon buttons that are their own control, not a Button, with the reason each stays. */
const OWN_CONTROL: Record<string, { count: number; reason: string }> = {
  'src/renderer/product/chat/RunButton.tsx': { count: 1, reason: 'send and stop: a round solid button with a progress ring' },
  'src/renderer/product/agentButton/AgentButton.tsx': { count: 1, reason: "the draggable floating agent button, drawn as the agent's figure" },
  'src/renderer/product/chat/WorkbenchChatScreen.tsx': { count: 2, reason: 'toast dismiss: moves with a Toast primitive' },
  'src/renderer/product/circles/CircleOfferAlerts.tsx': { count: 1, reason: 'toast dismiss: moves with a Toast primitive' },
  'src/renderer/product/chat/circle/CirclePlace.tsx': { count: 1, reason: 'toast dismiss: moves with a Toast primitive' },
  'src/renderer/product/chat/WorkbenchThread.tsx': { count: 1, reason: "the composer's @ chip: a .wb-chip in the composer's chip row, not an icon button" },
  'src/renderer/product/circles/CirclesDock.tsx': { count: 1, reason: 'a Circle row: CircleRowContent draws its name' },
  'src/renderer/product/desktopAgent/CirclesPanelTab.tsx': { count: 1, reason: 'a Circle row: CircleRowContent draws its name' },
};

const allowed = (file: string) => OWN_CONTROL[file]?.count ?? 0;

/** assistant-ui primitives that render a button of their own. */
const PRIMITIVE_BUTTON = /<(ActionBarPrimitive\.(?:Copy|Edit|Reload|Speak|StopSpeaking|FeedbackPositive|FeedbackNegative)|BranchPickerPrimitive\.(?:Previous|Next))\b/g;

/** Primitive buttons opened without asChild, which render an unstyled `<button>`. */
function primitivesWithoutAsChild(source: string): string[] {
  return [...source.matchAll(PRIMITIVE_BUTTON)]
    .filter((match) => !/(?:^|\s)asChild(?:[\s=/]|$)/.test(attributes(source, match.index + match[0].length)))
    .map((match) => match[1]);
}

const counts = new Map(
  sources(renderer, ui)
    .map((path) => [relative(root, path), countRaw(readFileSync(path, 'utf8'))] as const)
    .filter(([, count]) => count > 0),
);

describe('raw icon buttons', () => {
  it('counts icon buttons', () => {
    expect(countRaw('<button aria-label="x"><X /></button>')).toBe(1);
    expect(countRaw('<button aria-label="x">×</button>')).toBe(1);
    expect(countRaw('<button aria-label="x">Save</button>')).toBe(0);
    expect(countRaw('<button aria-label="x">{label}</button>')).toBe(0);
    expect(countRaw('<button aria-label="x">{open ? <A /> : <B />}</button>')).toBe(1);
    expect(countRaw('<Button size="icon" aria-label="x"><X /></Button>')).toBe(0);
    expect(countRaw('<button><X /></button>')).toBe(1);
    expect(countRaw('<button title="x"><X /></button>')).toBe(1);
    expect(countRaw('<button aria-label="x" />')).toBe(0);
    expect(countRaw('<button aria-label="x">{open ? <b>Hide</b> : <i />}</button>')).toBe(0);
    expect(countRaw('<button aria-label={`More for ${name}`}>\n  {/* why */}\n  <svg viewBox="0 0 16 16"><path d="M1 2" /></svg>\n</button>')).toBe(1);
    expect(countRaw('<button aria-label="x"><span>{name}</span></button>')).toBe(0);
    expect(countRaw('<button aria-label="x"><span aria-hidden="true" /><svg /></button>')).toBe(1);
  });

  it('no file has hand-built icon buttons outside OWN_CONTROL', () => {
    const found = [...counts].flatMap(([file, count]) =>
      count > allowed(file)
        ? [`${file}: ${count} hand-built icon buttons, allowed ${allowed(file)}. Use Button with size="icon", "icon-sm" or "icon-xs".`]
        : [],
    );
    expect(found).toEqual([]);
  });

  it('finds assistant-ui buttons without asChild', () => {
    expect(primitivesWithoutAsChild('<ActionBarPrimitive.Copy copiedDuration={1400}><CopyIcon /></ActionBarPrimitive.Copy>')).toEqual(['ActionBarPrimitive.Copy']);
    expect(primitivesWithoutAsChild('<ActionBarPrimitive.Copy copiedDuration={1400} asChild><Button /></ActionBarPrimitive.Copy>')).toEqual([]);
    expect(primitivesWithoutAsChild('<BranchPickerPrimitive.Next asChild>')).toEqual([]);
    expect(primitivesWithoutAsChild('<ActionBarPrimitive.Root className="wb-acts">')).toEqual([]);
  });

  it("assistant-ui's buttons wrap a Button with asChild", () => {
    const found = sources(renderer, ui).flatMap((path) =>
      primitivesWithoutAsChild(readFileSync(path, 'utf8')).map(
        (name) => `${relative(root, path)}: <${name}> renders its own unstyled button. Add asChild and wrap a Button.`,
      ),
    );
    expect(found).toEqual([]);
  });

  it('allowances are not stale', () => {
    const stale = Object.keys(OWN_CONTROL).flatMap((file) => {
      if (!existsSync(join(root, file))) return [`${file}: the file is gone; remove its entry.`];
      const count = counts.get(file) ?? 0;
      return count === allowed(file) ? [] : [`${file}: ${count} found, ${allowed(file)} allowed; update its count and reason.`];
    });
    expect(stale).toEqual([]);
  });
});
