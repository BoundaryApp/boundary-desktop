import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { BOUNDARY_ASSISTANT_OVERLAY_FILENAME } from '../../../shared/assistantStackConstants';
import { persistDebugLog } from '../../persistDebugLog';
import { readEnvFile } from './stackEnv';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the Boundary compose overlay shipped with the app.
 */
export function resolveBoundaryOverlayPath(): string {
  const candidates: string[] = [];

  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, 'assistant', BOUNDARY_ASSISTANT_OVERLAY_FILENAME)
    );
  }

  try {
    candidates.push(
      path.join(app.getAppPath(), 'resources', 'assistant', BOUNDARY_ASSISTANT_OVERLAY_FILENAME)
    );
  } catch {
    // ignore
  }

  candidates.push(
    path.join(process.cwd(), 'resources', 'assistant', BOUNDARY_ASSISTANT_OVERLAY_FILENAME)
  );
  candidates.push(
    path.resolve(moduleDir, '../../../../resources/assistant', BOUNDARY_ASSISTANT_OVERLAY_FILENAME)
  );
  candidates.push(
    path.resolve(moduleDir, '../../../resources/assistant', BOUNDARY_ASSISTANT_OVERLAY_FILENAME)
  );

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Boundary assistant compose overlay not found (${BOUNDARY_ASSISTANT_OVERLAY_FILENAME}).`
  );
}

/** Boundary-managed assistant-stack directory under Electron userData. */
export function resolveAssistantStackHome(): string {
  return path.join(app.getPath('userData'), 'assistant-stack');
}

/**
 * Compose project cwd: pinned sovereign-agent-stack tree under userData.
 */
export function resolveAssistantProjectRoot(): string {
  return path.join(resolveAssistantStackHome(), 'project');
}

/**
 * Repo `data/` tree — Hermes agent state (`data/hermes`) and Boundary's
 * unified compose bind when ASSISTANT_DATA_ROOT is unset.
 * User-authored projects/voice/memory live under
 * {@link resolveAssistantUserContentRoot}.
 */
export function resolveAssistantDataRoot(projectRoot?: string): string {
  return path.join(projectRoot ?? resolveAssistantProjectRoot(), 'data');
}

export function readAssistantEnvFile(projectRoot: string): Record<string, string> {
  return readEnvFile(path.join(projectRoot, '.env'));
}

function expandAssistantEnvPath(raw: string, projectRoot: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return resolveAssistantDataRoot(projectRoot);
  }
  let expanded = trimmed;
  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(projectRoot, expanded);
}

/**
 * User-authored content root (`projects/`, `voice/`, `memory/`, LightRAG
 * inputs). Honors `ASSISTANT_DATA_ROOT` from `{projectRoot}/.env` — the
 * assistant data-dir convention (`~/AssistantData`). Falls back to
 * `{projectRoot}/data` when unset or empty.
 *
 * Hermes state stays at {@link resolveAssistantDataRoot} (`./data/hermes`)
 * even when this root is relocated.
 */
export function resolveAssistantUserContentRoot(projectRoot?: string): string {
  const root = projectRoot ?? resolveAssistantProjectRoot();
  const raw = readAssistantEnvFile(root).ASSISTANT_DATA_ROOT;
  if (!raw?.trim()) {
    return resolveAssistantDataRoot(root);
  }
  return expandAssistantEnvPath(raw, root);
}

export function resolveAssistantWorkspaceRoot(): string {
  return path.join(resolveAssistantStackHome(), 'workspace');
}

export function resolveProvisionMarkerPath(): string {
  return path.join(resolveAssistantStackHome(), '.provision.json');
}

/** True when root is Boundary's userData project (safe to run setup.sh). */
export function isBoundaryOwnedAssistantRoot(root: string): boolean {
  const owned = path.resolve(resolveAssistantProjectRoot());
  return path.resolve(root) === owned;
}

export async function ensureAssistantDataDirs(dataRoot: string): Promise<void> {
  const subdirs = [
    'hermes',
    'hermes/memories',
    'projects',
    'voice',
    'memory',
    'rag_storage',
    'inputs',
    'neo4j/data',
    'neo4j/logs',
    'gptr/outputs',
    'n8n',
    'opencode/config',
    'opencode/data',
  ];
  await fs.promises.mkdir(dataRoot, { recursive: true });
  for (const sub of subdirs) {
    await fs.promises.mkdir(path.join(dataRoot, sub), { recursive: true });
  }
}

export async function ensureAssistantWorkspaceDir(workspaceRoot: string): Promise<void> {
  await fs.promises.mkdir(workspaceRoot, { recursive: true });
}

const MINIMAL_OPENCODE_CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "local/your-chat-model",
  "mcp": {
    "searxng": {
      "type": "remote",
      "url": "http://mcp-searxng:3000/mcp",
      "enabled": true,
      "timeout": 10000
    },
    "gptr": {
      "type": "sse",
      "url": "http://gptr-mcp:8000/sse",
      "enabled": true,
      "timeout": 300000
    }
  },
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local OpenAI-compatible",
      "options": {
        "baseURL": "http://host.docker.internal:1234/v1"
      },
      "models": {
        "your-chat-model": {
          "name": "Local chat model"
        }
      }
    }
  },
  "disabled_providers": ["openai", "anthropic", "google"]
}
`;

/**
 * OpenCode requires opencode.local.json (gitignored upstream). Prefer the
 * project file when present; otherwise write a Boundary-managed stub under data.
 */
export async function ensureOpenCodeConfigFile(
  assistantRoot: string,
  dataRoot: string
): Promise<string> {
  const checkoutLocal = path.join(assistantRoot, 'opencode', 'opencode.local.json');
  if (fs.existsSync(checkoutLocal)) {
    return checkoutLocal;
  }

  const checkoutTemplate = path.join(assistantRoot, 'opencode', 'opencode.json');
  const boundaryConfig = path.join(dataRoot, 'opencode', 'opencode.local.json');
  await fs.promises.mkdir(path.dirname(boundaryConfig), { recursive: true });

  if (!fs.existsSync(boundaryConfig)) {
    if (fs.existsSync(checkoutTemplate)) {
      await fs.promises.copyFile(checkoutTemplate, boundaryConfig);
    } else {
      await fs.promises.writeFile(boundaryConfig, MINIMAL_OPENCODE_CONFIG, 'utf8');
    }
  }

  return boundaryConfig;
}

const HERMES_GATEWAY_PROFILES = ['api-server', 'browser'] as const;

/**
 * Errors seen right after a container that mounted the stub exits (`hermes setup` leaves
 * `profiles/<name>/memories` as a mount point), while Docker Desktop releases it.
 * Node's own `maxRetries` doesn't cover EACCES.
 */
const TRANSIENT_RM_CODES = new Set(['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY']);
const PROFILE_RM_ATTEMPTS = 5;

async function rmWithRetry(target: string, retryDelayMs: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_RM_CODES.has(code) || attempt >= PROFILE_RM_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
}

/**
 * Hermes bootstrap assumes each listed profile has a config.yaml (cloned from
 * default). Stub dirs without config.yaml make `hermes profile list` report the
 * profile, bootstrap skips clone, then set_yaml_list exits 1.
 *
 * A stub that still can't be removed after retries is logged and left in place rather
 * than failing start-up here; the next start tries again.
 */
export async function removeIncompleteHermesProfiles(
  dataRoot: string,
  options: { retryDelayMs?: number } = {}
): Promise<string[]> {
  const removed: string[] = [];
  for (const profile of HERMES_GATEWAY_PROFILES) {
    const profileDir = path.join(dataRoot, 'hermes', 'profiles', profile);
    const profileConfig = path.join(profileDir, 'config.yaml');
    if (fs.existsSync(profileDir) && !fs.existsSync(profileConfig)) {
      try {
        await rmWithRetry(profileDir, options.retryDelayMs ?? 250);
        removed.push(profile);
      } catch (error) {
        persistDebugLog('assistant-stack', 'could not remove incomplete Hermes profile', {
          profileDir,
          code: (error as NodeJS.ErrnoException).code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return removed;
}

export function hermesConfigExists(dataRoot: string): boolean {
  return fs.existsSync(path.join(dataRoot, 'hermes', 'config.yaml'));
}
