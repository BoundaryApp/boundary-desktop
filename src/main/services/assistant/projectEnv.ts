import { outcomeText, runAddonScript } from '../addons/addonScript';
import type { StackCommands, StackFiles } from '../stackHost/types';
import { removeEnvLines, upsertEnvLines, writeStackEnvValues } from './stackEnv';

/**
 * Changes to keys in the stack's project `.env` that a client may write (remote stack plan,
 * phase 3a). The stack's `scripts/env.sh` (CR 0037 R3, stack v0.3.16) makes each change under
 * the config lock `addon.sh` holds, so it works the same on a local or a remote host and never
 * races another client. A stack without the script, such as an older developer checkout, gets
 * the change written to the file instead.
 *
 * Add-on switches (`*_ENABLED`, `COMPOSE_PROFILES`) belong to `addon.sh`. Keys outside
 * `env.sh`'s allowlist (`DETECTOR_PORT`, `LIGHTRAG_LLM_*`, keys Boundary retired) and secrets
 * (values go on the script's command line) are written with `writeStackEnvValues` instead.
 */
export interface ProjectEnv {
  /** Sets each key. True when the file changed. */
  set(values: Record<string, string>): Promise<boolean>;
  /** Removes each key's lines. True when the file changed. */
  unset(keys: readonly string[]): Promise<boolean>;
}

const ENV_SCRIPT = 'scripts/env.sh';

/**
 * What `env.sh` accepts at v0.3.16 (its `client_writable`), minus the add-on switches. v0.3.17 also
 * accepts `LIGHTRAG_LLM_*` and `EMBEDDING_*`; they stay off this list so an older stack's script
 * never refuses a change Boundary routes to it.
 */
const CLIENT_WRITABLE = /^(?:LLM_(?!PROXY_ADMIN_TOKEN$)[A-Z0-9_]*|[A-Z][A-Z0-9_]*_IMAGE(?:_TAG)?|HERMES_TERMINAL_BACKEND|CODING_[A-Z0-9_]*|CONTEXT_[A-Z0-9_]*|CALDAV_TZ)$/;

/** Whether `env.sh` lets a client change `key`. */
export function isClientWritableEnvKey(key: string): boolean {
  return CLIENT_WRITABLE.test(key) && !key.endsWith('_ENABLED');
}

/** Names Boundary as the lock's holder, and waits out another client's change. */
const LOCK_ENV = { STACK_CLIENT: 'boundary', STACK_LOCK_TIMEOUT: '30' };
const SCRIPT_TIMEOUT_MS = 60_000;

/**
 * The raw text after `KEY=` on each line that sets `key`, as `env.sh` compares it: a key set on
 * exactly one line to the same text is left alone.
 */
function rawLines(contents: string, key: string): string[] {
  const prefix = `${key}=`;
  return contents
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

function assertWritable(keys: readonly string[]): void {
  const refused = keys.filter((key) => !isClientWritableEnvKey(key));
  if (refused.length) throw new Error(`env.sh doesn't let a client change ${refused.join(', ')}`);
}

/** Writes the stack's `.env` through `StackFiles`, for a stack without `env.sh`. */
export function projectEnvViaFiles(files: StackFiles): ProjectEnv {
  const edit = async (change: (contents: string) => string): Promise<boolean> => {
    const contents = await files.readText('stack', '.env');
    const next = change(contents ?? '');
    if (contents !== null && next === contents) return false;
    if (contents === null && next === '') return false;
    await files.writeText('stack', '.env', next);
    return true;
  };
  return {
    set: (values) => edit((contents) => upsertEnvLines(contents, values)),
    unset: (keys) => edit((contents) => removeEnvLines(contents, keys)),
  };
}

type ScriptRunner = Pick<StackCommands, 'runScript' | 'scriptEnv'>;

/**
 * Changes keys through `env.sh` when the stack has it, one run per key that would change, else
 * through the file. Rejects on a key `env.sh` doesn't accept and on any run that fails.
 */
export function projectEnvVia(commands: ScriptRunner, files: StackFiles): ProjectEnv {
  const run = async (args: string[]): Promise<boolean> => {
    const env = { ...(await commands.scriptEnv([])), ...LOCK_ENV };
    const outcome = await runAddonScript({
      runScript: commands.runScript,
      script: 'env.sh',
      args: [...args, '--json'],
      env,
      timeoutMs: SCRIPT_TIMEOUT_MS,
    });
    if (outcome.kind !== 'done') throw new Error(`env.sh ${args[0]} ${args[1]}: ${outcomeText(outcome)}`);
    return outcome.done.changed === true;
  };

  const fallback = projectEnvViaFiles(files);
  const hasScript = () => files.exists('stack', ENV_SCRIPT);

  return {
    async set(values) {
      const keys = Object.keys(values);
      assertWritable(keys);
      if (!(await hasScript())) return fallback.set(values);
      const contents = (await files.readText('stack', '.env')) ?? '';
      let changed = false;
      for (const key of keys) {
        const current = rawLines(contents, key);
        if (current.length === 1 && current[0] === values[key]) continue;
        if (await run(['set', key, values[key]])) changed = true;
      }
      return changed;
    },
    async unset(keys) {
      assertWritable(keys);
      if (!(await hasScript())) return fallback.unset(keys);
      const contents = (await files.readText('stack', '.env')) ?? '';
      let changed = false;
      for (const key of keys) {
        if (rawLines(contents, key).length === 0) continue;
        if (await run(['unset', key])) changed = true;
      }
      return changed;
    },
  };
}

/**
 * Sets keys `env.sh` accepts through `env`, and the rest (`DETECTOR_PORT`, `LIGHTRAG_LLM_*`)
 * through the file. True when anything changed.
 */
export async function setProjectEnvValues(
  env: ProjectEnv,
  files: StackFiles,
  values: Record<string, string>
): Promise<boolean> {
  const entries = Object.entries(values);
  const viaScript = Object.fromEntries(entries.filter(([key]) => isClientWritableEnvKey(key)));
  const viaFile = Object.fromEntries(entries.filter(([key]) => !isClientWritableEnvKey(key)));
  const fileChanged = Object.keys(viaFile).length ? await writeStackEnvValues(files, 'stack', '.env', viaFile) : false;
  const scriptChanged = Object.keys(viaScript).length ? await env.set(viaScript) : false;
  return fileChanged || scriptChanged;
}
