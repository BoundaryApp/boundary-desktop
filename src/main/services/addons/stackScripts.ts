import { getAssistantStackAccess } from '../assistant/AssistantStackService';
import { resolveAssistantUserContentRoot } from '../assistant/assistantPaths';
import { getContainerRuntime, runCli, runCompose } from '../containerRuntime';
import { runAddonScript, runAddonScriptPlain, runScriptJson, type AddonScript, type AddonScriptLine, type AddonScriptOutcome, type PlainOutcome, type ScriptJsonOutcome } from './addonScript';

// The stack's add-on scripts on the live stack: run in the stack root with the stack's script
// environment, which in the managed stack carries Boundary's compose project, files and env, so
// the scripts' own compose calls reach the same project.

export function runOnStack(
  script: AddonScript,
  args: string[],
  options: { input?: Record<string, unknown>; timeoutMs?: number; onLine?: (line: AddonScriptLine) => void } = {}
): Promise<AddonScriptOutcome> {
  const access = getAssistantStackAccess();
  return access.scriptEnv([]).then((env) => runAddonScript({ root: access.root, env, script, args, ...options }));
}

/** A script whose output is not phase lines: `addon.sh configure` and `run` (the email service) and `vault.sh follow-hermes`. */
export function runPlainOnStack(script: AddonScript, args: string[], options: { input?: Record<string, unknown>; timeoutMs?: number } = {}): Promise<PlainOutcome> {
  const access = getAssistantStackAccess();
  return access.scriptEnv([]).then((env) => runAddonScriptPlain({ root: access.root, env, script, args, ...options }));
}

export function runJsonOnStack(script: AddonScript, args: string[], options: { timeoutMs?: number } = {}): Promise<ScriptJsonOutcome> {
  const access = getAssistantStackAccess();
  return access.scriptEnv([]).then((env) => runScriptJson({ root: access.root, env, script, args, ...options }));
}

/**
 * Compose with the environment the stack's scripts get, so it reaches the project `vault.sh`'s
 * own compose calls do. `profiles` join COMPOSE_PROFILES, as the scripts' `compose_with_profile`
 * adds one. Resolves with stdout; rejects when compose fails.
 */
export async function composeOnStack(args: string[], options: { profiles?: string[]; timeoutMs?: number } = {}): Promise<string> {
  const access = getAssistantStackAccess();
  const [env, runtime] = await Promise.all([access.scriptEnv(options.profiles ?? []), getContainerRuntime()]);
  const { stdout } = await runCompose(runtime, args, { cwd: access.root, env, timeout: options.timeoutMs });
  return stdout;
}

/** The container CLI (`docker` or `podman`) with the same environment. Resolves with stdout. */
export async function cliOnStack(args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
  const access = getAssistantStackAccess();
  const [env, runtime] = await Promise.all([access.scriptEnv([]), getContainerRuntime()]);
  const { stdout } = await runCli(runtime, args, { cwd: access.root, env, timeout: options.timeoutMs });
  return stdout;
}

/**
 * The stack root and the stack's data root, where its add-on stores live (`addons/actual`,
 * `addons/bitwarden`). The stack's scripts take that root from `ASSISTANT_DATA_ROOT` in its
 * `.env` and fall back to `./data`, so it can sit outside the stack root. Twenty's data and
 * Hermes state stay under the stack root's `data/` (`getAssistantStackAccess().dataRoot`).
 */
export function stackPaths(): { root: string; dataRoot: string } {
  const { root } = getAssistantStackAccess();
  return { root, dataRoot: resolveAssistantUserContentRoot(root) };
}
