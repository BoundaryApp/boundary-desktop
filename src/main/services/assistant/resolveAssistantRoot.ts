import fs from 'node:fs';
import path from 'node:path';
import { BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE, SOVEREIGN_AGENT_STACK_GITHUB_URL } from '../../../shared/assistantStackConstants';
import { resolveAssistantDataRoot, resolveAssistantProjectRoot } from './assistantPaths';
import { stackMode } from './localStackMode';
import { APP_NAME } from '../../../shared/buildIdentity';
import { remoteStackFolderRefusal } from '../stackHost/stackHostLocation';

export class AssistantRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantRootError';
  }
}

/** A cached "the compose file is there" is checked again in the background after this long. */
const RECHECK_AFTER_MS = 5_000;

/**
 * Compose files found, by path, with when each was last confirmed. Only finds are kept: a
 * missing file is checked again on every call, so a stack installed a moment ago resolves at
 * once. A kept find is rechecked without blocking, because this runs on the main thread many
 * times a minute and a local stack sits under ~/Documents, where a blocking check can wait on
 * a macOS permission prompt.
 */
const confirmedComposeFiles = new Map<string, number>();
const recheckInFlight = new Set<string>();

function recheckInBackground(composeFile: string): void {
  if (recheckInFlight.has(composeFile)) return;
  recheckInFlight.add(composeFile);
  fs.promises.access(composeFile).then(
    () => confirmedComposeFiles.set(composeFile, Date.now()),
    () => confirmedComposeFiles.delete(composeFile)
  ).finally(() => recheckInFlight.delete(composeFile));
}

function looksLikeAssistantRoot(candidate: string): boolean {
  const composeFile = path.join(candidate, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE);
  const confirmedAt = confirmedComposeFiles.get(composeFile);
  if (confirmedAt !== undefined) {
    if (Date.now() - confirmedAt >= RECHECK_AFTER_MS) recheckInBackground(composeFile);
    return true;
  }
  const found = fs.existsSync(composeFile);
  if (found) confirmedComposeFiles.set(composeFile, Date.now());
  return found;
}

/** Drops cached compose-file finds, so the next resolve checks the disk. */
export function forgetAssistantRootChecks(): void {
  confirmedComposeFiles.clear();
}

/**
 * The stack root {@link stackMode} picked (BOUNDARY_ASSISTANT_ROOT, then the stored override,
 * then the managed install), once its compose file is there. Does not fall back to a sibling
 * ../assistant checkout (developer stacks stay separate). Throws when the stored stack location
 * is another computer, so code still on local paths fails by name instead of using a folder here.
 */
export function resolveAssistantRoot(): string {
  const remote = remoteStackFolderRefusal();
  if (remote) throw new AssistantRootError(remote);
  const { root, source } = stackMode();
  if (looksLikeAssistantRoot(root)) return root;
  if (source === 'BOUNDARY_ASSISTANT_ROOT') {
    throw new AssistantRootError(
      `BOUNDARY_ASSISTANT_ROOT is set but ${BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE} was not found at ${root}`
    );
  }
  if (source === 'stored-override') {
    throw new AssistantRootError(
      `Configured assistant root is missing ${BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE}: ${root}`
    );
  }
  throw new AssistantRootError(
    `Could not find the ${APP_NAME}-managed agent stack at ${root} ` +
      `(expected ${BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE} from ${SOVEREIGN_AGENT_STACK_GITHUB_URL}). ` +
      'Start the assistant stack from Setup to download it, or set BOUNDARY_ASSISTANT_ROOT for a local override.'
  );
}

export function tryResolveAssistantRoot(): { root: string | null; error?: string } {
  try {
    return { root: resolveAssistantRoot() };
  } catch (error) {
    return {
      root: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The stack this session talks to: the resolved root (local checkout or managed install),
 * else the managed install path. Every Hermes-state path should derive from this, so a
 * local-stack session never reads or writes the userData install. Throws when the stack is on
 * another computer.
 */
export function resolveActiveAssistantRoot(): string {
  const remote = remoteStackFolderRefusal();
  if (remote) throw new AssistantRootError(remote);
  const { root } = tryResolveAssistantRoot();
  return root ?? resolveAssistantProjectRoot();
}

/** `data/` under the active stack — Hermes state lives at `<this>/hermes`. */
export function resolveActiveAssistantDataRoot(): string {
  return resolveAssistantDataRoot(resolveActiveAssistantRoot());
}
