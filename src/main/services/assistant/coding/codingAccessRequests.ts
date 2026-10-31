import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CodingAccessRequestEvent } from '../../../../shared/types/codingFolders';
import { codingGrantDeps } from './codingGrants';
import { codingGrantRefuseMessage, folderFacts, refuseCodingGrantReason } from './codingGrantRules';
import { currentCodingRoots } from './codingMounts';
import { isPathUnder, samePath } from '../../hostPaths';
import { listStoredHermesProjects } from '../hermes/hermesProjectStore';
import { APP_NAME } from '../../../../shared/buildIdentity';

/**
 * Turn an `opencode-mcp` "needs access" result into a coding-access card (ADR 0028 §9). The
 * card replaces the skill's `make coding-root-add` hint for app users; Hermes never grants
 * access itself.
 */

const CODING_TOOL = /(^|[^a-z])coding_(start|continue)_task$/i;

export function isCodingTaskTool(name: string | null | undefined): boolean {
  return Boolean(name && CODING_TOOL.test(name.trim()));
}

function stringField(text: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

/**
 * The path a coding tool asked for, when its result says it needs access. Reads the JSON,
 * falling back to field matching when the gateway truncated the result text, then to the
 * call's own `directory` argument.
 */
export function needsAccessPath(
  resultText: string | null | undefined,
  args: Record<string, unknown> | null | undefined
): string | null {
  if (!resultText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object') {
    const body = parsed as { needs_access?: unknown; path?: unknown };
    if (body.needs_access !== true) return null;
    if (typeof body.path === 'string' && body.path.trim()) return body.path.trim();
  } else if (!/"needs_access"\s*:\s*true/.test(resultText)) {
    return null;
  }
  const fromText = stringField(resultText, 'path');
  if (fromText?.trim()) return fromText.trim();
  const directory = args?.directory;
  return typeof directory === 'string' && directory.trim() ? directory.trim() : null;
}

/**
 * A path under `/opt/projects/<slug>` names a host-folder project's folder as Hermes sees it
 * (change request 0003 R2). Map it back to the Mac path; anything else is returned as is.
 */
export function hostPathForAlias(raw: string): string {
  const clean = path.resolve(raw);
  for (const project of listStoredHermesProjects()) {
    if (project.kind !== 'host-folder' || !project.containerPath) continue;
    const alias = path.resolve(project.containerPath);
    if (clean === alias) return path.resolve(project.hostPath);
    if (isPathUnder(clean, alias)) {
      return path.join(path.resolve(project.hostPath), path.relative(alias, clean));
    }
  }
  return clean;
}

/** Build the event the renderer shows, or null when there's nothing for the user to decide. */
export function buildCodingAccessRequest(input: {
  toolName: string | null | undefined;
  resultText: string | null | undefined;
  args: Record<string, unknown> | null | undefined;
  sessionId: string;
  requestId: string;
  projectId: string | null;
}): CodingAccessRequestEvent | null {
  if (!isCodingTaskTool(input.toolName)) return null;
  const deps = codingGrantDeps();
  if (deps.isLocalStack()) return null;
  const raw = needsAccessPath(input.resultText, input.args);
  if (!raw || !path.isAbsolute(raw)) return null;
  const hostPath = hostPathForAlias(raw);
  const projectFolder =
    listStoredHermesProjects().find(
      (project) => project.kind === 'host-folder' && samePath(project.hostPath, hostPath)
    ) ?? null;
  // Already covered (granted since the call ran): Hermes can simply retry.
  if (currentCodingRoots().some((root) => isPathUnder(hostPath, root))) return null;
  const { isDirectory: exists, isGit } = folderFacts(hostPath);
  // A missing folder is judged by the parent it would be created in.
  const judged = exists ? hostPath : path.dirname(hostPath);
  const reason = refuseCodingGrantReason(judged, deps.ruleOptions());
  const refused = reason && !(reason === 'home' && !exists) ? reason : null;
  return {
    id: randomUUID(),
    sessionId: input.sessionId,
    requestId: input.requestId,
    hostPath,
    name: path.basename(hostPath),
    exists,
    isGit,
    projectId: input.projectId,
    projectFolderId: projectFolder?.id ?? null,
    projectFolderName: projectFolder?.name ?? null,
    refuseMessage: refused
      ? refused === 'missing'
        ? `${path.dirname(hostPath)} doesn’t exist, so ${APP_NAME} can’t create the folder there.`
        : codingGrantRefuseMessage(refused)
      : null,
  };
}
