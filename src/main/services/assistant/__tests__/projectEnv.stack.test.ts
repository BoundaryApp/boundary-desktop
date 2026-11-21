/**
 * Stack contract: `scripts/env.sh set|unset --json` (CR 0037 R3, stack v0.3.16) as Boundary's
 * `projectEnvVia` runs it (ADR 0031 §1). Copies the stack's `scripts/` into a temp folder with a
 * made-up `.env`, so nothing in the stack tree changes. Needs only the stack's checkout and
 * `bash`, not a running stack.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localRunScript } from '../../stackHost/localScript';
import { localStackFiles } from '../../stackHost/localStackHost';
import { isClientWritableEnvKey, projectEnvVia } from '../projectEnv';
import { defaultStackRoot } from './stackHarness';

const root = process.env.BOUNDARY_ASSISTANT_ROOT?.trim() || defaultStackRoot();
const hasScript = !!root && fs.existsSync(path.join(root, 'scripts', 'env.sh'));

describe.skipIf(!hasScript)(
  `env.sh set and unset${hasScript ? '' : ' (skipped: no scripts/env.sh in the stack folder)'}`,
  () => {
    let tmp: string;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-env-sh-'));
      fs.cpSync(path.join(root, 'scripts'), path.join(tmp, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.env'), 'LLM_MODEL=old\nKEEP=1\nOLD_IMAGE=x\n');
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const envAt = (scriptEnv: NodeJS.ProcessEnv = {}) =>
      projectEnvVia(
        { runScript: localRunScript(tmp), scriptEnv: async () => ({ PATH: process.env.PATH, ...scriptEnv }) },
        localStackFiles({ stackRoot: tmp, userContentRoot: () => path.join(tmp, 'data') })
      );

    it('sets, leaves alone and unsets keys, keeping other lines', async () => {
      const env = envAt();
      expect(await env.set({ LLM_MODEL: 'new', CODING_EXTRA_ROOTS: "'/a b'" })).toBe(true);
      expect(await env.set({ LLM_MODEL: 'new' })).toBe(false);
      expect(await env.unset(['OLD_IMAGE'])).toBe(true);
      expect(fs.readFileSync(path.join(tmp, '.env'), 'utf8')).toBe("LLM_MODEL=new\nKEEP=1\nCODING_EXTRA_ROOTS='/a b'\n");
    });

    it('accepts every key Boundary sends through it', async () => {
      const env = envAt();
      const keys = ['LLM_BINDING', 'LLM_BINDING_API_KEY', 'N8N_IMAGE', 'HERMES_AGENT_IMAGE_TAG', 'HERMES_TERMINAL_BACKEND', 'CODING_ROOTS_APP_MANAGED', 'CONTEXT_EXTRA_ROOTS'];
      for (const key of keys) expect(isClientWritableEnvKey(key)).toBe(true);
      await env.set(Object.fromEntries(keys.map((key) => [key, 'v'])));
      const text = fs.readFileSync(path.join(tmp, '.env'), 'utf8');
      for (const key of keys) expect(text).toContain(`${key}=v\n`);
    });

    it('fails with busy while another client holds the config lock', async () => {
      fs.mkdirSync(path.join(tmp, 'data', 'addons'), { recursive: true });
      // A live holder: this test's own process.
      fs.symlinkSync(`${process.pid}:cli:${Math.floor(Date.now() / 1000)}`, path.join(tmp, 'data', 'addons', '.lock'));
      const env = projectEnvVia(
        {
          runScript: (script, args, options) =>
            localRunScript(tmp)(script, args, { ...options, env: { ...options.env, STACK_LOCK_TIMEOUT: '0' } }),
          scriptEnv: async () => ({ PATH: process.env.PATH }),
        },
        localStackFiles({ stackRoot: tmp, userContentRoot: () => path.join(tmp, 'data') })
      );
      await expect(env.set({ LLM_MODEL: 'x' })).rejects.toThrow(/^env\.sh set LLM_MODEL: busy: .*client cli/);
    });
  }
);
