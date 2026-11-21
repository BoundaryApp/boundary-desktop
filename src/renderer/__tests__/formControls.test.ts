import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(here, '../../index.css'), 'utf8');
const tokens = readFileSync(join(here, '../styles/tokens.css'), 'utf8');
const workbench = readFileSync(join(here, '../product/chat/workbench.css'), 'utf8');

/** The `select { ... }` block inside index.css's base layer. */
function baseSelectRule(): string {
  const layer = index.slice(index.indexOf('@layer base {'));
  const match = /\n {2}select \{([\s\S]*?)\n {2}\}/.exec(layer);
  return match ? match[1] : '';
}

describe('select caret', () => {
  it('draws one caret for every select, with room before it, from the base layer', () => {
    const rule = baseSelectRule();
    expect(rule).toContain('appearance: none !important;');
    expect(rule).toContain('background-image: var(--select-caret) !important;');
    expect(rule).toContain('background-repeat: no-repeat !important;');
    expect(rule).toMatch(/padding-inline-end: calc\([^;]*var\(--select-caret-size\)[^;]*\) !important;/);
  });

  it('gives each theme its own caret color', () => {
    const light = tokens.slice(tokens.indexOf(":root[data-theme='light']"));
    const dark = tokens.slice(0, tokens.indexOf(":root[data-theme='light']"));
    expect(dark).toContain('--select-caret: url("data:image/svg+xml');
    expect(dark).toContain('--select-caret-size:');
    expect(light).toContain('--select-caret: url("data:image/svg+xml');
  });
});

describe('field captions', () => {
  it('styles only a span directly inside .wb-field as its caption', () => {
    // A descendant selector turned red errors in a Field hint into faint uppercase captions.
    expect(workbench).toMatch(/\.wb-field > span,\n\.wb-field-label \{/);
    expect(workbench).not.toMatch(/\.wb-field span[,\s{]/);
  });
});

describe('cascade layers', () => {
  const root = join(here, '../../..');
  const stylesheets = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : stylesheets(path);
      return entry.name.endsWith('.css') ? [path] : [];
    });

  /** Top-level statements and block preludes, comments removed. */
  function topLevel(css: string): string[] {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const found: string[] = [];
    let depth = 0;
    let buffer = '';
    for (const char of text) {
      if (char === '{') {
        if (depth === 0) found.push(buffer.trim());
        depth += 1;
        buffer = '';
      } else if (char === '}') {
        depth -= 1;
        buffer = '';
      } else if (char === ';' && depth === 0) {
        found.push(buffer.trim());
        buffer = '';
      } else if (depth === 0) {
        buffer += char;
      }
    }
    return found.filter(Boolean);
  }

  it('puts every app rule in a layer, so utilities outrank app rules', () => {
    const files = stylesheets(join(root, 'src')).filter((path) => !path.endsWith('tokens.css'));
    expect(files.length).toBeGreaterThan(10);
    for (const path of files) {
      const statements = topLevel(readFileSync(path, 'utf8'));
      const name = relative(root, path);
      if (!name.endsWith('src/index.css')) {
        expect(statements[0], name).toBe('@layer theme, base, components, utilities, markdown');
      }
      const stray = statements.filter((s) => !/^@(layer|property|import|source|theme|utility)\b/.test(s));
      expect(stray, name).toEqual([]);
    }
  });
});

/** Every stylesheet under src/ except index.css, tokens.css and experiments (which keep their own
 *  inputs), as [path from repo root, css without comments]. */
function appStylesheets(): [string, string][] {
  const root = join(here, '../../..');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'experiments' ? [] : walk(path);
      return entry.name.endsWith('.css') ? [path] : [];
    });
  return walk(join(root, 'src'))
    .filter((path) => !/(^|\/)(index|tokens)\.css$/.test(path))
    .map((path) => [relative(root, path), readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')]);
}

/** Splits on `separator` characters outside parentheses and brackets. */
function splitTop(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (depth === 0 && separator.test(char)) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Each selector in a stylesheet's style rules (at-rule preludes skipped). */
function selectors(css: string): string[] {
  return [...css.matchAll(/([^{};]+)\{/g)]
    .map((match) => match[1].trim())
    .filter((prelude) => !prelude.startsWith('@'))
    .flatMap((prelude) => splitTop(prelude, /,/))
    .map((selector) => selector.replace(/\s+/g, ' '));
}

/** The last compound of a selector: what the rule styles. */
function subject(selector: string): string {
  return splitTop(selector.replace(/\s*([>+~])\s*/g, ' '), /\s/).at(-1) ?? '';
}

const CONTROL = /^(?:input|textarea|select)$/;
const PSEUDO_OR_ATTRIBUTE = /^(?:\[[^\]]*\]|::?[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?)*$/;

/** A compound that is a bare input, textarea or select, or an :is() list naming one, with any
 *  pseudo-classes and attribute selectors after it. A class or data-slot makes it not bare. */
function isBareControl(compound: string): boolean {
  const type = /^(?:input|textarea|select)/.exec(compound);
  if (type) return PSEUDO_OR_ATTRIBUTE.test(compound.slice(type[0].length));
  if (!compound.startsWith(':is(')) return false;
  let depth = 0;
  let end = 0;
  for (let i = 3; i < compound.length; i += 1) {
    if (compound[i] === '(') depth += 1;
    if (compound[i] === ')' && --depth === 0) {
      end = i;
      break;
    }
  }
  const items = splitTop(compound.slice(4, end), /,/);
  return items.some((item) => CONTROL.test(item)) && PSEUDO_OR_ATTRIBUTE.test(compound.slice(end + 1));
}

// Rules that still style a bare control, each with its reason.
const BARE_CONTROL_ALLOWED: [RegExp, string][] = [
  [
    /^\.workbench :is\(/,
    "the shell's transition and focus for every control; the focus rule skips data-slot controls and serves the range slider, assistant-ui's composer and message editor, and experiments' inputs (ADR 0064 §10)",
  ],
  [/^\.wb-prose :is\(/, 'transition and focus for controls inside a reply'],
  [/^\.wb-thread-head :is\(/, "keeps controls in the thread header out of the window's drag region"],
  [/^\.wb-composer(\.is-locked)? textarea/, "assistant-ui's composer (ComposerPrimitive.Input), which isn't a components/ui control"],
  [/^\.wb-input-box textarea:not\(:where\(\[data-slot\]\)\)$/, "assistant-ui's composer inside its input box"],
  [/^\.wb-reply-text-slider input/, 'the reply text range slider, which has no primitive'],
];

describe('bare form controls', () => {
  it('no app rule styles a bare input, textarea or select by container', () => {
    const found: string[] = [];
    for (const [file, css] of appStylesheets()) {
      for (const selector of selectors(css)) {
        if (!isBareControl(subject(selector))) continue;
        if (BARE_CONTROL_ALLOWED.some(([allowed]) => allowed.test(selector))) continue;
        found.push(`${file}: ${selector} styles a bare form control. Style the component in components/ui/control.css.`);
      }
    }
    expect(found).toEqual([]);
  });

  it('no app rule restyles a switch by class', () => {
    const found: string[] = [];
    for (const [file, css] of appStylesheets()) {
      for (const selector of selectors(css)) {
        if (/(?:\.wb-switch|\.wb-circle-switch|\.wn-switch button)(?:\.[\w-]+|\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?)*$/.test(selector)) {
          found.push(`${file}: ${selector} restyles a switch. Switch draws itself from components/ui/choice.css (ADR 0064).`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('finds bare controls in a selector list', () => {
    const bare = (css: string) => selectors(css).filter((selector) => isBareControl(subject(selector)));
    expect(bare('.a input, .b > select:focus, .c textarea::placeholder { x: y }')).toHaveLength(3);
    expect(bare('.a input:not(:where([data-slot])) { x: y }')).toHaveLength(1);
    expect(bare('.a :is(input, select):focus-visible { x: y }')).toHaveLength(1);
    expect(bare('.a input.wb-x, .a [data-slot="input"], .a .input { x: y }')).toEqual([]);
    expect(bare(":is([data-slot='input'], [data-slot='textarea']):disabled { x: y }")).toEqual([]);
  });
});

describe('choice buttons', () => {
  it('no app rule styles a choice card, chip or segment by class', () => {
    // Only .wb-member-picks and .wb-check-filters stay, as layout classes on a ChipGroup.
    const old =
      /\.(?:wb-choices?|wb-choice-copy|wb-radio|wb-inference-choice|wb-inference-radio|wb-conf-choice|wb-all-chip|wb-check-filter|wb-all-chips|wb-seg|wb-vault-seg|wb-tasks-scope)(?![\w-])/;
    const found: string[] = [];
    for (const [file, css] of appStylesheets()) {
      for (const selector of selectors(css)) {
        if (old.test(selector)) found.push(`${file}: ${selector} styles a choice card, chip or segment. Use ChoiceRow, Chip or Segmented (ADR 0066).`);
      }
    }
    expect(found).toEqual([]);
  });

  it('no app rule keys a look on aria-pressed, aria-checked or role=radio', () => {
    const found: string[] = [];
    for (const [file, css] of appStylesheets()) {
      if (file.startsWith('src/renderer/components/ui/')) continue;
      for (const selector of selectors(css)) {
        if (!/\[aria-pressed|\[role=(?:'radio'|"radio"|radio)\]|\[aria-checked/.test(selector)) continue;
        found.push(`${file}: ${selector} keys a look on aria-pressed, aria-checked or role=radio. Use the components/ui control.`);
      }
    }
    expect(found).toEqual([]);
  });
});

// App-wide rules that list [role='option'] beside every other control, with their reason.
const MENU_ROLE_ALLOWED: [RegExp, string][] = [
  [/^\.(?:workbench|wb-prose) :is\(button, a, summary, /, "the shared control transition and focus ring, which list every control's role"],
];

describe('menus and listboxes', () => {
  it('no app rule styles a menu or list row by its old class', () => {
    // Popups that wrap a Menu or Listbox keep their own class for placement and surface
    // (.wb-mentions, .wb-busy-menu, .wb-proj-menu and its parts, [data-slot='listbox'].wb-vault-suggest);
    // only their old row rules go.
    const old =
      /\.(?:wb-menu|wb-insp-menu|wb-approve-menu|wb-proj-menu-item|wb-proj-menu-check|wb-proj-count|wb-move-dest|wb-vault-menu|wb-kept-voice-menu|wb-title-menu-pop|wb-title-menu-note|wb-mention-head|wb-dm-days?|wb-react-pop|wb-react-picks?|wb-react-full|wb-circles-menu|wb-circles-row-menu|wb-circles-row-levels|wb-agent-button-menu)(?![\w-])/;
    const oldRow = /\.(?:wb-mentions|wb-busy-menu|wb-vault-suggest)(?![\w-])[^,]*?(?:\bbutton\b|\.meta(?![\w-])|\.is-active(?![\w-]))/;
    const found: string[] = [];
    for (const [file, css] of appStylesheets()) {
      for (const selector of selectors(css)) {
        if (old.test(selector) || oldRow.test(selector)) {
          found.push(`${file}: ${selector} styles a menu or list row. Use Menu or Listbox from components/ui (ADR 0068).`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('no app rule keys a look on aria-selected or a menu or option role', () => {
    const found: string[] = [];
    for (const [file, css] of appStylesheets()) {
      if (file.startsWith('src/renderer/components/ui/')) continue;
      for (const selector of selectors(css)) {
        if (!/\[aria-checked|\[aria-selected|\[role=['"]?menu|\[role=(?:'option'|"option"|option)\]/.test(selector)) continue;
        if (MENU_ROLE_ALLOWED.some(([allowed]) => allowed.test(selector))) continue;
        found.push(`${file}: ${selector} keys a look on a menu or option state. Use Menu or Listbox from components/ui (ADR 0068).`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe('icon buttons', () => {
  it('no app rule styles an icon button by its old class', () => {
    // Icon buttons are Button with size="icon", "icon-sm" or "icon-xs" (ADR 0061). Layout classes
    // on them (.wb-copy-act, .wb-circles-row-more) stay.
    const old =
      /\.(?:wb-act|wb-sect-add|wb-icon-more|wb-circles-more|wb-circle-panel-btn|wb-check-close|wb-saved-login-close|wb-voice-file-remove|wb-qchip-act|wb-inf-ico|wn-close|su-panel-close)(?![\w-])|\.(?:wb-voice-chip|wb-settings-sheet-head) button(?![\w-])/;
    const found: string[] = [];
    for (const [file, css] of appStylesheets()) {
      for (const selector of selectors(css)) {
        if (old.test(selector)) found.push(`${file}: ${selector} styles an icon button. Use Button with an icon size (ADR 0061).`);
      }
    }
    expect(found).toEqual([]);
  });

  it("keeps rules that change a Button's own box in the utilities layer, where Button's look is", () => {
    // In components, button.css's utilities-layer look would outrank them whatever their specificity.
    const utilities = workbench.lastIndexOf('@layer utilities {');
    for (const rule of ['.wb-copy-act[data-copied] {', '.wb-acts > .wb-btn:disabled {', '.wb-msg:hover > .wb-acts > .wb-btn,']) {
      expect(workbench.indexOf(rule), rule).toBeGreaterThan(utilities);
    }
    expect(utilities).toBeGreaterThan(-1);
  });
});

describe('tabs', () => {
  it('no app rule styles a tab by its old class', () => {
    // App-wide rules that list [role='tab'] beside buttons (transitions, focus ring, no-drag) stay.
    const old = /\.(?:wb-settings-tabs|wb-dm-tabs?|wb-folder-tabs|wb-folder-count|wb-desktop-panel-tabs?)(?![\w-])/;
    const found: string[] = [];
    for (const [file, css] of appStylesheets()) {
      for (const selector of selectors(css)) {
        if (old.test(selector)) found.push(`${file}: ${selector} styles a tab. Use Tabs from components/ui.`);
      }
    }
    expect(found).toEqual([]);
  });
});
