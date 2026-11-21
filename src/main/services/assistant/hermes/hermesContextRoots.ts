import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import { resolveAssistantWorkspaceRoot } from '../assistantPaths';
import { getStackFiles } from '../../stackHost/activeStack';
import type { StackFiles } from '../../stackHost/types';
import type { ProjectEnv } from '../projectEnv';
import { readStackEnv, writeStackEnvValues } from '../stackEnv';
import { listStoredHermesProjects } from './hermesProjectStore';
import { isLocalAssistantStackMode } from '../localStackMode';
import { codingGrantPaths } from '../coding/codingMounts';
import {
  extraHostPathsFromSources,
  filterMountableContextRoots,
  loadSources,
  serializeColonPaths,
  splitColonPaths,
} from './projectSourcesModel';
import { hasStackCapability } from '../../stackHost/capabilities';

/** Coding roots from the stack `.env` values in `env` and from Boundary's own grants. */
export function readCodingRoots(env: Record<string, string>): string[] {
  const roots = [
    ...splitColonPaths(env.CODING_EXTRA_ROOTS),
    ...splitColonPaths(env.OPENCODE_WORKSPACE_HOST),
    ...splitColonPaths(env.BOUNDARY_OPENCODE_WORKSPACE),
    // Boundary's own grants (ADR 0028). A developer stack manages its roots itself.
    ...(isLocalAssistantStackMode() ? [] : codingGrantPaths()),
  ];
  try {
    const workspace = resolveAssistantWorkspaceRoot();
    if (workspace && fs.existsSync(workspace)) {
      roots.push(workspace);
    }
  } catch {
    /* tests and early boot may lack Electron userData */
  }
  return roots;
}

export function listedExtraSourcePaths(
  projects: readonly HermesProjectRecord[] = listStoredHermesProjects()
): string[] {
  const out: string[] = [];
  for (const project of projects) {
    try {
      const loaded = loadSources(project.hostPath);
      out.push(...extraHostPathsFromSources(loaded.sources));
    } catch {
      /* skip unreadable hubs */
    }
  }
  return out;
}

export async function collectContextExtraRoots(options?: {
  drop?: readonly string[];
  projects?: readonly HermesProjectRecord[];
  env?: Record<string, string>;
  home?: string;
  files?: StackFiles;
}): Promise<string[]> {
  if (!hasStackCapability('hostFolders')) return [];
  const env = options?.env ?? (await readStackEnv(options?.files ?? getStackFiles(), 'stack', '.env'));
  const projects = options?.projects ?? listStoredHermesProjects();
  const drop = new Set((options?.drop ?? []).map((item) => path.resolve(item)));
  const listed = listedExtraSourcePaths(projects);
  const candidates = [
    ...splitColonPaths(env.CONTEXT_EXTRA_ROOTS),
    ...listed,
  ].filter((item) => !drop.has(path.resolve(item)));
  const codingRoots = readCodingRoots(env);
  return filterMountableContextRoots(candidates, {
    home: options?.home ?? os.homedir(),
    codingRoots,
    requireDirectory: true,
  });
}

export async function persistContextExtraRoots(
  roots: readonly string[],
  env: ProjectEnv
): Promise<void> {
  await env.set({ CONTEXT_EXTRA_ROOTS: serializeColonPaths(roots) });
}

/** The compose override of a developer checkout, relative to the stack folder. */
const OVERRIDE_REL = 'docker-compose.override.yml';

function contextBindLine(root: string): string {
  return `      - ${JSON.stringify(`${root}:${root}:ro`)}`;
}

/**
 * The service that runs Hermes's file and shell tools in a developer checkout, read from its
 * `.env` the way the stack's scripts/context-root.sh reads it: hermes-worker under the default
 * ssh backend, hermes under `local`.
 */
export async function localTerminalService(files: StackFiles): Promise<'hermes-worker' | 'hermes'> {
  const backend = (await readStackEnv(files, 'stack', '.env')).HERMES_TERMINAL_BACKEND?.trim() || 'ssh';
  return backend === 'local' ? 'hermes' : 'hermes-worker';
}

/** Index of the line after `service`'s block (the next top-level service, or the end). */
function serviceBlockEnd(lines: readonly string[], start: number): number {
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[a-zA-Z0-9_-]+:\s*$/.test(lines[i]?.replace(/\n$/, '') ?? '')) return i;
  }
  return lines.length;
}

/**
 * Identity :ro binds for the live sibling stack (automatic override.yml), on the terminal
 * service, where the stack's own context-root.sh puts them. Only adds binds.
 */
export async function upsertHermesContextOverrideBinds(
  roots: readonly string[],
  files: StackFiles = getStackFiles()
): Promise<void> {
  if (!hasStackCapability('hostFolders')) return;
  let text =
    (await files.readText('stack', OVERRIDE_REL)) ??
    (await files.readText('stack', `${OVERRIDE_REL}.example`)) ??
    'services:\n';
  if (!/(^|\n)services:\s*$/m.test(text) && !text.includes('\nservices:') && !text.startsWith('services:')) {
    text = `services:\n${text}`;
  }
  const service = await localTerminalService(files);
  const lines = text.split(/(?<=\n)/);
  let serviceIdx = lines.findIndex((line) => line.replace(/\n$/, '') === `  ${service}:`);
  const block = serviceIdx < 0 ? '' : lines.slice(serviceIdx, serviceBlockEnd(lines, serviceIdx)).join('');
  const needed = roots.filter((root) => !block.includes(`${root}:${root}`));
  if (needed.length === 0) {
    return;
  }
  if (serviceIdx < 0) {
    if (text.length > 0 && !text.endsWith('\n')) {
      lines.push('\n');
    }
    lines.push(`  ${service}:\n`, '    volumes:\n');
    serviceIdx = lines.length - 2;
  }
  let volIdx = -1;
  for (let i = serviceIdx + 1; i < serviceBlockEnd(lines, serviceIdx); i += 1) {
    if (lines[i]?.replace(/\n$/, '') === '    volumes:') {
      volIdx = i;
      break;
    }
  }
  const insertAt = volIdx >= 0 ? volIdx + 1 : serviceIdx + 1;
  if (volIdx < 0) {
    lines.splice(insertAt, 0, '    volumes:\n');
  }
  const bindAt = volIdx >= 0 ? insertAt : insertAt + 1;
  lines.splice(bindAt, 0, ...needed.map((root) => `${contextBindLine(root)}\n`));
  await files.writeText('stack', OVERRIDE_REL, lines.join(''));
}
