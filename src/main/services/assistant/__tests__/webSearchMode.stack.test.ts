/**
 * Stack contract: HERMES_WEB_SEARCH_MODE, which Boundary passes to the hermes service (ADR 0031
 * §1). Runs only under `bun run test:stack`.
 *
 * Calls the stack's overlay (agent/web_search_mode.py in the Hermes image) read-only: its mode
 * list, how it reads a value, and the value the running container holds. No search or page read
 * is made, so nothing reaches SearXNG or the keyless services. Skips on a stack that predates
 * the overlay.
 */
import { describe, expect, it } from 'vitest';
import { WEB_SEARCH_MODES } from '../../../../shared/webSearchMode';
import { probeStack, pythonJsonInHermes, skipNote } from './stackHarness';

const probe = await probeStack();

interface OverlayFacts {
  installed: boolean;
  modes?: string[];
  env?: string | null;
  current?: string;
  mixedCase?: string;
  unknown?: string;
  unset?: string;
}

const PROGRAM = `
import json, os
try:
    from agent import web_search_mode as w
except Exception:
    print(json.dumps({"installed": False}))
    raise SystemExit(0)
print(json.dumps({
    "installed": True,
    "modes": list(w.MODES),
    "env": os.environ.get(w.ENV),
    "current": w.current_mode(),
    "mixedCase": w.current_mode({w.ENV: "  Keyless-First "}),
    "unknown": w.current_mode({w.ENV: "public"}),
    "unset": w.current_mode({}),
}))
`;

describe.skipIf(!probe.ok)(`HERMES_WEB_SEARCH_MODE${skipNote(probe)}`, () => {
  it('the overlay reads the modes Boundary offers, the way Boundary writes them', async (ctx) => {
    if (!probe.ok) return;
    const facts = await pythonJsonInHermes<OverlayFacts>(probe.target, PROGRAM);
    if (!facts.installed) {
      ctx.skip('this stack has no agent/web_search_mode.py');
      return;
    }
    expect(facts.modes).toEqual([...WEB_SEARCH_MODES]);
    // The running container's value, whoever set it, is one Boundary would show.
    expect(WEB_SEARCH_MODES as readonly string[]).toContain(facts.current);
    expect(facts.mixedCase).toBe('keyless-first');
    expect(facts.unknown).toBe('private');
    expect(facts.unset).toBe('private');
  });
});
