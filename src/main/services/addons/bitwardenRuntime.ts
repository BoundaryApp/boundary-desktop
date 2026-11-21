import { BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE } from '../../../shared/assistantStackConstants';
import { persistDebugLog } from '../../persistDebugLog';
import { getContainerRuntime } from '../containerRuntime/resolveContainerRuntime';
import { onBeforeStackUp, onHermesReplaced } from '../assistant/hermesLifecycle';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { tryResolveAssistantRoot } from '../assistant/resolveAssistantRoot';
import { getStackFiles, stackFilesAt } from '../stackHost/activeStack';
import { BITWARDEN_ENTRY } from './addonCatalog';
import { checkAddonFit } from './addonFitCheck';
import { runExclusive } from './addonLock';
import { bitwardenOffered, createBitwardenService, readBitwardenEnabled, type BitwardenService } from './bitwardenAddon';
import { ensureBitwardenFolders } from './bitwardenFolders';
import { removeStaleSignerVolume } from './signerVolume';
import { refreshCredentialClientFiles } from '../hostBridge/hostBridgeService';
import { cliOnStack, composeOnStack, runJsonOnStack, runOnStack, runPlainOnStack, stackPaths } from './stackScripts';
import type { BitwardenInstallerDeps } from './bitwardenInstaller';

// Bitwarden's service and installer on the live stack (stackScripts.ts runs the scripts), so
// `vault.sh`'s `docker compose exec` reaches the same project as Boundary.

const log = (message: string, data: Record<string, unknown>) => persistDebugLog('addons', `bitwarden ${message}`, data);

const paths = stackPaths;

let shared: BitwardenService | null = null;

export function getBitwardenService(): BitwardenService {
  shared ??= createBitwardenService({
    files: getStackFiles(),
    run: runOnStack,
    runJson: runJsonOnStack,
    exclusive: runExclusive,
    startBroker,
    ensureFolders: async () => {
      await ensureBitwardenFolders(stackPaths(), process.env);
      await prepareSignerVolume();
      // The secrets folder may be new: the relay's credential client files go in it (ADR 0065).
      await refreshCredentialClientFiles();
    },
    log,
  });
  return shared;
}

/** True while Bitwarden is offered on this stack and switched on; every `vault.sh` call outside the installer is gated on it. */
async function bitwardenActive(): Promise<boolean> {
  const { root } = tryResolveAssistantRoot();
  if (!root) return false;
  const files = stackFilesAt(root);
  return (await bitwardenOffered(files)) && (await readBitwardenEnabled(files));
}

/**
 * On bundled Podman, removes a signer volume made before the engine overlay's options (CR 0042 R2,
 * signerVolume.ts). Local-stack mode runs the checkout's compose files without the overlay, so it
 * is left alone there.
 */
async function prepareSignerVolume(): Promise<void> {
  if (isLocalAssistantStackMode()) return;
  await removeStaleSignerVolume({
    runtimeKind: async () => (await getContainerRuntime()).kind,
    composeText: async () => (await getStackFiles().readText('stack', BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE)) ?? '',
    cli: (args) => cliOnStack(args, { timeoutMs: SIGNER_VOLUME_TIMEOUT_MS }),
    log,
  });
}

const SIGNER_VOLUME_TIMEOUT_MS = 60_000;

const BROKER_START_TIMEOUT_MS = 120_000;

/**
 * Starts a stopped broker. From stack v0.3.16 it has its own network namespace and
 * `restart: unless-stopped`, so this is only for a broker someone stopped; `vault.sh follow-hermes`,
 * which did this before, is gone.
 */
async function startBroker(): Promise<void> {
  await composeOnStack(['up', '-d', '--no-deps', 'bitwarden-broker'], { profiles: ['bitwarden'], timeoutMs: BROKER_START_TIMEOUT_MS });
}

/** `vault.sh pre-up` creates the host folders Bitwarden's compose file mounts; `up-hook` reloads the plugins. */
const PRE_UP_TIMEOUT_MS = 60_000;
const UP_HOOK_TIMEOUT_MS = 120_000;

async function runPreUp(): Promise<void> {
  if (!(await bitwardenActive())) return;
  await prepareSignerVolume();
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

/**
 * Wires Bitwarden into the stack's start: `pre-up` before compose `up`, then `up-hook` after
 * hermes starts. From stack v0.3.16 the broker doesn't share hermes's network namespace, so a
 * later restart or recreate of hermes needs nothing from Boundary.
 * Call once at startup; the returned function removes the listeners.
 */
export function registerBitwardenStackHooks(): () => void {
  const offBefore = onBeforeStackUp(runPreUp);
  const offReplaced = onHermesReplaced(async (reason) => {
    if (reason === 'start' && (await bitwardenActive())) await runUpHook();
  });
  return () => {
    offBefore();
    offReplaced();
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
  if (!root) return;
  void bitwardenOffered(stackFilesAt(root))
    .then((offered) => (offered ? getBitwardenService().refreshRequests() : undefined))
    .catch((error: unknown) => log('requests after tool call failed', { error: error instanceof Error ? error.name : 'unknown' }));
}
