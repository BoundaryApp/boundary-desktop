import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8');

/** The declarations of every rule whose selector list is exactly `selector`. */
function rules(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm'))].map((m) => m[1]);
}

const NO_DRAG = /-webkit-app-region:\s*no-drag/;

// The start-up screen is a window drag area, and Electron sends clicks on anything drawn over a
// drag area to moving the window unless that element is marked no-drag. What's new opens over it.
describe('overlays above the start-up screen take clicks', () => {
  it('starts from a start-up screen that drags the window', () => {
    expect(rules(read('../../startup/startup.css'), '.su-root').join('')).toMatch(/-webkit-app-region:\s*drag/);
  });

  it('marks the sheet backdrop no-drag', () => {
    expect(rules(read('../../chat/workbench.css'), '.wb-sheet-backdrop').join('')).toMatch(NO_DRAG);
  });

  it('marks the What’s new opt-out toast no-drag', () => {
    expect(rules(read('../whatsNew.css'), '.wn-toast').join('')).toMatch(NO_DRAG);
  });
});
