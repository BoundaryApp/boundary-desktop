/**
 * Stack contract: the Bitwarden broker follows a recreated hermes (stack v0.3.14,
 * `vault.sh follow-hermes`; spec phase 8).
 *
 * Skipped unless the stack under test has Bitwarden on (`BITWARDEN_ENABLED=1` in its `.env`) and
 * the add-on's scripts. When it runs it recreates the stack's `hermes` container, which ends any
 * chat running in it. It then checks, as the stack's doctor.sh does, that the broker's
 * `HostConfig.NetworkMode` is no longer `container:<running hermes id>` (`vault.sh status` can't
 * tell), lets Boundary's follower run `vault.sh follow-hermes`, and checks that it is again. It
 * reads container ids and the network mode only: no account secret and no status line.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAddonScriptPlain } from '../../addons/addonScript';
import { bitwardenOffered, readBitwardenEnabled } from '../../addons/bitwardenAddon';
import { readBrokerNamespace } from '../../addons/bitwardenBrokerNamespace';
import { createHermesFollower } from '../../addons/bitwardenFollowHermes';
import { readEnvFile } from '../stackEnv';
import { probeStack, skipNote } from './stackHarness';

const probe = await probeStack();
const root = probe.ok ? probe.target.root : '';
const on = probe.ok && bitwardenOffered(root) && readBitwardenEnabled(root);
const note = probe.ok && !on ? ' (skipped: BITWARDEN_ENABLED isn’t 1 in the stack under test, or it has no Bitwarden add-on)' : skipNote(probe);

/** Exit code and stdout; stderr is dropped. */
function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

/** The stack's profiles plus `bitwarden`, as its scripts' `compose_with_profile bitwarden` passes them. */
function bitwardenProfiles(): string {
  const csv = process.env.COMPOSE_PROFILES ?? readEnvFile(path.join(root, '.env')).COMPOSE_PROFILES ?? 'core';
  const profiles = csv.split(',').map((p) => p.trim()).filter((p) => p && p !== 'bitwarden');
  return [...profiles, 'bitwarden'].join(',');
}

describe.skipIf(!on)(`Bitwarden broker after hermes is recreated${note}`, () => {
  it('moves the broker into the new hermes’s network namespace', { timeout: 600_000 }, async () => {
    if (!probe.ok) return;
    const docker = probe.target.docker;
    const env = { ...process.env };
    const composeEnv = { ...env, COMPOSE_PROFILES: bitwardenProfiles() };
    const stdout = async (file: string, args: string[], e: NodeJS.ProcessEnv): Promise<string> => {
      const result = await run(file, args, e);
      if (result.code !== 0) throw new Error(`${args.slice(0, 2).join(' ')} exited ${result.code}`);
      return result.stdout;
    };
    const reads = {
      compose: (args: string[]) => stdout(docker, ['compose', ...args], composeEnv),
      cli: (args: string[]) => stdout(docker, args, env),
    };
    const runningId = async (service: string) => (await reads.compose(['ps', '--status', 'running', '-q', service])).trim();
    const networkMode = async () => {
      const broker = await runningId('bitwarden-broker');
      expect(broker).not.toBe('');
      return (await reads.cli(['inspect', '-f', '{{.HostConfig.NetworkMode}}', broker])).trim();
    };

    const logged: Array<Record<string, unknown>> = [];
    const follower = createHermesFollower({
      active: () => true,
      run: () => runAddonScriptPlain({ root, env, script: 'vault.sh', args: ['follow-hermes'], timeoutMs: 120_000 }),
      refresh: async () => undefined,
      log: (_message, data) => void logged.push(data),
    });

    expect((await run(docker, ['compose', 'up', '-d', '--no-deps', '--force-recreate', 'hermes'], env)).code).toBe(0);
    const recreated = await runningId('hermes');
    expect(recreated).not.toBe('');
    // The precondition: the broker still sits in the removed hermes's namespace.
    expect(await networkMode()).not.toBe(`container:${recreated}`);
    expect(await readBrokerNamespace(reads)).toEqual({ ok: true, matches: false });

    await follower.follow('broker-down');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ code: 0 });

    expect(await runningId('hermes')).toBe(recreated);
    expect(await networkMode()).toBe(`container:${recreated}`);
    expect(await readBrokerNamespace(reads)).toEqual({ ok: true, matches: true });
  });
});
