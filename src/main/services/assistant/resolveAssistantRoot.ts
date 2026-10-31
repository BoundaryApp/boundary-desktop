import fs from 'node:fs';
import path from 'node:path';
import { BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE, SOVEREIGN_AGENT_STACK_GITHUB_URL } from '../../../shared/assistantStackConstants';
import { getAssistantRootOverride } from './AssistantStackStore';
import { resolveAssistantDataRoot, resolveAssistantProjectRoot } from './assistantPaths';
import { APP_NAME } from '../../../shared/buildIdentity';

export class AssistantRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantRootError';
  }
}

function looksLikeAssistantRoot(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE));
}

/**
 * Resolve the Boundary-managed (or explicitly overridden) agent stack compose directory.
 * Precedence: BOUNDARY_ASSISTANT_ROOT → electron-store override → userData/assistant-stack/project.
 * Does not fall back to a sibling ../assistant checkout (developer stacks stay separate).
 */
export function resolveAssistantRoot(): string {
  const fromEnv = process.env.BOUNDARY_ASSISTANT_ROOT?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (!looksLikeAssistantRoot(resolved)) {
      throw new AssistantRootError(
        `BOUNDARY_ASSISTANT_ROOT is set but ${BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE} was not found at ${resolved}`
      );
    }
    return resolved;
  }

  const fromStore = getAssistantRootOverride();
  if (fromStore) {
    const resolved = path.resolve(fromStore);
    if (!looksLikeAssistantRoot(resolved)) {
      throw new AssistantRootError(
        `Configured assistant root is missing ${BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE}: ${resolved}`
      );
    }
    return resolved;
  }

  const projectRoot = resolveAssistantProjectRoot();
  if (looksLikeAssistantRoot(projectRoot)) {
    return projectRoot;
  }

  throw new AssistantRootError(
    `Could not find the ${APP_NAME}-managed agent stack at ${projectRoot} ` +
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
 * local-stack session never reads or writes the userData install.
 */
export function resolveActiveAssistantRoot(): string {
  const { root } = tryResolveAssistantRoot();
  return root ?? resolveAssistantProjectRoot();
}

/** `data/` under the active stack — Hermes state lives at `<this>/hermes`. */
export function resolveActiveAssistantDataRoot(): string {
  return resolveAssistantDataRoot(resolveActiveAssistantRoot());
}
