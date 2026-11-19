import { app } from 'electron';
import { persistDebugLog } from '../../persistDebugLog';
import { onBeforeStackUp, onHermesReplaced } from '../assistant/hermesLifecycle';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { tryResolveAssistantRoot } from '../assistant/resolveAssistantRoot';
import { BITWARDEN_ENTRY } from './addonCatalog';
import { checkAddonFit } from './addonFitCheck';
import { runExclusive } from './addonLock';
import { bitwardenOffered, createBitwardenService, readBitwardenEnabled, type BitwardenService } from './bitwardenAddon';
import { ensureBitwardenFolders } from './bitwardenFolders';
import { readBrokerNamespace, type BrokerNamespaceCheck } from './bitwardenBrokerNamespace';
import { startBrokerWatch } from './bitwardenBrokerWatch';
import { createHermesFollower, type HermesFollower } from './bitwardenFollowHermes';
import { cliOnStack, composeOnStack, runJsonOnStack, runOnStack, runPlainOnStack, stackPaths } from './stackScripts';
import type { BitwardenInstallerDeps } from './bitwardenInstaller';

// Bitwarden's service and installer on the live stack (stackScripts.ts runs the scripts), so
// `vault.sh`'s `docker compose exec` reaches the same project as Boundary.

const log = (message: string, data: Record<string, unknown>) => persistDebugLog('addons', `bitwarden ${message}`, data);

const paths = stackPaths;

let shared: BitwardenService | null = null;

export function getBitwardenService(): BitwardenService {
  shared ??= createBitwardenService({
    paths,
    run: runOnStack,
    runJson: runJsonOnStack,
    exclusive: runExclusive,
    followHermes: () => getHermesFollower().follow('broker-down'),
    checkBrokerNamespace,
    ensureFolders: () => ensureBitwardenFolders(stackPaths(), process.env),
    log,
  });
  return shared;
}

/** True while Bitwarden is offered on this stack and switched on; every `vault.sh` call outside the installer is gated on it. */
function bitwardenActive(): boolean {
  const { root } = tryResolveAssistantRoot();
  return !!root && bitwardenOffered(root) && readBitwardenEnabled(root);
}

const NAMESPACE_READ_TIMEOUT_MS = 30_000;

/** doctor.sh's check that the broker shares the running hermes's network namespace, while Bitwarden is active. */
export function checkBrokerNamespace(): Promise<BrokerNamespaceCheck> {
  if (!bitwardenActive()) return Promise.resolve({ ok: false, reason: 'inactive' });
  return readBrokerNamespace({
    compose: (args) => composeOnStack(args, { profiles: ['bitwarden'], timeoutMs: NAMESPACE_READ_TIMEOUT_MS }),
    cli: (args) => cliOnStack(args, { timeoutMs: NAMESPACE_READ_TIMEOUT_MS }),
  });
}

let follower: HermesFollower | null = null;

/** Moves the broker into hermes's new network namespace after hermes changes; does nothing while Bitwarden is off. */
export function getHermesFollower(): HermesFollower {
  follower ??= createHermesFollower({
    active: bitwardenActive,
    run: () => runPlainOnStack('vault.sh', ['follow-hermes'], { timeoutMs: 120_000 }),
    // The follower's own refresh must not repair, or the two would call each other.
    refresh: () => getBitwardenService().refresh({ repair: false }),
    log,
  });
  return follower;
}

/** `vault.sh pre-up` creates the host folders Bitwarden's compose file mounts; `up-hook` reloads the plugins. */
const PRE_UP_TIMEOUT_MS = 60_000;
const UP_HOOK_TIMEOUT_MS = 120_000;

async function runPreUp(): Promise<void> {
  if (!bitwardenActive()) return;
  const started = Date.now();
  const { code } = await runPlainOnStack('vault.sh', ['pre-up'], { timeoutMs: PRE_UP_TIMEOUT_MS });
  log('pre-up', { code, ms: Date.now() - started });
  if (code !== 0) throw new Error(`Bitwarden’s folders couldn’t be created (vault.sh pre-up exited ${code}).`);
}

/** A failure here is logged and ignored: the start has already succeeded. */
async function runUpHook(): Promise<void> {
  const started = Date.now();
  try {
    const { code } = await runPlainOnStack('vault.sh', ['up-hook'], { timeoutMs: UP_HOOK_TIMEOUT_MS });
    log('up-hook', { code, ms: Date.now() - started });
  } catch (error) {
    log('up-hook', { error: error instanceof Error ? error.name : typeof error, ms: Date.now() - started });
  }
}

/** Electron's focus event for any of Boundary's windows. */
function onAnyWindowFocus(listener: () => void): () => void {
  app.on('browser-window-focus', listener);
  return () => void app.off('browser-window-focus', listener);
}

/**
 * Wires Bitwarden into the stack's start: `pre-up` before compose `up`, then `up-hook` and the
 * follower after hermes starts, and the follower alone after later restarts and recreates. Also
 * watches for a hermes recreated outside Boundary (bitwardenBrokerWatch.ts).
 * Call once at startup; the returned function removes the listeners and stops the watch.
 */
export function registerBitwardenStackHooks(): () => void {
  const offBefore = onBeforeStackUp(runPreUp);
  const offReplaced = onHermesReplaced(async (reason) => {
    if (reason === 'start' && bitwardenActive()) await runUpHook();
    await getHermesFollower().follow(reason);
  });
  const stopWatch = startBrokerWatch({
    active: bitwardenActive,
    check: (trigger) => getBitwardenService().repairIfStranded(trigger),
    onFocus: onAnyWindowFocus,
    log,
  });
  return () => {
    offBefore();
    offReplaced();
    stopWatch();
  };
}

export function createDefaultBitwardenInstallerDeps(): BitwardenInstallerDeps {
  return {
    service: getBitwardenService(),
    run: runOnStack,
    paths,
    checkFit: async () => (await checkAddonFit(BITWARDEN_ENTRY)).fit,
    isLocalStack: isLocalAssistantStackMode,
    exclusive: runExclusive,
    log,
  };
}

/** The tool Hermes's Bitwarden plugin gives the agent to ask for a login it can't reach. */
const REQUEST_TOOL = 'bitwarden_request_access';

/**
 * After a chat's tool call finishes: when it was the agent asking for a login, read the
 * pending requests again so Bitwarden's page and the Services dot show it (decision 30). The
 * tool name is all this reads from the turn.
 */
export function noteChatToolCall(toolName: string): void {
  if (toolName !== REQUEST_TOOL) return;
  const { root } = tryResolveAssistantRoot();
  if (!root || !bitwardenOffered(root)) return;
  void getBitwardenService()
    .refreshRequests()
    .catch((error: unknown) => log('requests after tool call failed', { error: error instanceof Error ? error.name : 'unknown' }));
}
