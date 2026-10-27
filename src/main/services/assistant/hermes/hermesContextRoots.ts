import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import {
  readAssistantEnvFile,
  resolveAssistantWorkspaceRoot,
} from '../assistantPaths';
import { resolveActiveAssistantRoot } from '../resolveAssistantRoot';
import { writeEnvValues } from '../stackEnv';
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

export function readCodingRoots(env?: Record<string, string>): string[] {
  const parsed = env ?? readAssistantEnvFile(resolveActiveAssistantRoot());
  const roots = [
    ...splitColonPaths(parsed.CODING_EXTRA_ROOTS),
    ...splitColonPaths(parsed.OPENCODE_WORKSPACE_HOST),
    ...splitColonPaths(parsed.BOUNDARY_OPENCODE_WORKSPACE),
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

export function collectContextExtraRoots(options?: {
  drop?: readonly string[];
  projects?: readonly HermesProjectRecord[];
  env?: Record<string, string>;
  home?: string;
  envRoot?: string;
}): string[] {
  const envRoot = options?.envRoot ?? resolveActiveAssistantRoot();
  const env = options?.env ?? readAssistantEnvFile(envRoot);
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

export function persistContextExtraRoots(
  roots: readonly string[],
  envRoot = resolveActiveAssistantRoot()
): void {
  writeEnvValues(path.join(envRoot, '.env'), { CONTEXT_EXTRA_ROOTS: serializeColonPaths(roots) });
}

function contextBindLine(root: string): string {
  return `      - ${JSON.stringify(`${root}:${root}:ro`)}`;
}

/**
 * The service that runs Hermes's file and shell tools in a developer checkout, read from its
 * `.env` the way the stack's scripts/context-root.sh reads it: hermes-worker under the default
 * ssh backend, hermes under `local`.
 */
export function localTerminalService(assistantRoot: string): 'hermes-worker' | 'hermes' {
  const backend = readAssistantEnvFile(assistantRoot).HERMES_TERMINAL_BACKEND?.trim() || 'ssh';
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
export function upsertHermesContextOverrideBinds(
  roots: readonly string[],
  assistantRoot: string
): string {
  const overridePath = path.join(assistantRoot, 'docker-compose.override.yml');
  const examplePath = path.join(assistantRoot, 'docker-compose.override.yml.example');
  let text: string;
  if (fs.existsSync(overridePath)) {
    text = fs.readFileSync(overridePath, 'utf8');
  } else if (fs.existsSync(examplePath)) {
    text = fs.readFileSync(examplePath, 'utf8');
  } else {
    text = 'services:\n';
  }
  if (!/(^|\n)services:\s*$/m.test(text) && !text.includes('\nservices:') && !text.startsWith('services:')) {
    text = `services:\n${text}`;
  }
  const service = localTerminalService(assistantRoot);
  const lines = text.split(/(?<=\n)/);
  let serviceIdx = lines.findIndex((line) => line.replace(/\n$/, '') === `  ${service}:`);
  const block = serviceIdx < 0 ? '' : lines.slice(serviceIdx, serviceBlockEnd(lines, serviceIdx)).join('');
  const needed = roots.filter((root) => !block.includes(`${root}:${root}`));
  if (needed.length === 0) {
    return overridePath;
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
  fs.writeFileSync(overridePath, lines.join(''), 'utf8');
  return overridePath;
}
