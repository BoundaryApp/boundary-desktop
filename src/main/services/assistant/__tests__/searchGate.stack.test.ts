/**
 * Stack contract: the search gate Boundary routes web searches through (BOUNDARY_WEB_SEARCH_URL).
 * Runs only under `bun run test:stack`, and only when the target stack's .env sets
 * SEARCH_GATE_ENABLED=1, since a developer stack starts the gate only then.
 *
 * Calls /healthz alone: /search would send a query to the engines, and the gate's cache holds
 * queries from chat.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOUNDARY_WEB_SEARCH_URL } from '../../../../shared/assistantStackConstants';
import { readEnvFile } from '../stackEnv';
import { execInHermes, probeStack, skipNote } from './stackHarness';

const probe = await probeStack();
const gateEnabled =
  probe.ok && readEnvFile(path.join(probe.target.root, '.env')).SEARCH_GATE_ENABLED === '1';

const HEALTHZ_PROGRAM = `
import json, sys, urllib.request
with urllib.request.urlopen(sys.argv[1] + "/healthz", timeout=10) as res:
    print(json.dumps({"status": res.status, "body": json.load(res)}))
`;

describe.skipIf(!gateEnabled)(
  `search gate${probe.ok ? (gateEnabled ? '' : ' (skipped: SEARCH_GATE_ENABLED is not 1 in the stack .env)') : skipNote(probe)}`,
  () => {
    it('answers /healthz at Boundary’s web search URL from the compose network', async () => {
      if (!probe.ok) throw new Error('unreachable: skipped above');
      const run = await execInHermes(probe.target, [
        'python3',
        '-c',
        HEALTHZ_PROGRAM,
        BOUNDARY_WEB_SEARCH_URL,
      ]);
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout.trim())).toEqual({ status: 200, body: { ok: true } });
    });
  }
);
