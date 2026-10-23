import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import { upsertEnvLine } from '../applyLlmToProjectEnv';
import {
  readAssistantEnvFile,
  resolveAssistantWorkspaceRoot,
} from '../assistantPaths';
import { resolveActiveAssistantRoot } from '../resolveAssistantRoot';
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

export function resolveAssistantEnvRoot(): string {
  return resolveActiveAssistantRoot();
}

function readProjectEnv(envRoot = resolveAssistantEnvRoot()): Record<string, string> {
  return readAssistantEnvFile(envRoot);
}

export function readCodingRoots(env?: Record<string, string>): string[] {
  const parsed = env ?? readProjectEnv();
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
  const envRoot = options?.envRoot ?? resolveAssistantEnvRoot();
  const env = options?.env ?? readProjectEnv(envRoot);
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
  envRoot = resolveAssistantEnvRoot()
): void {
  const envPath = path.join(envRoot, '.env');
  let contents = '';
  if (fs.existsSync(envPath)) {
    contents = fs.readFileSync(envPath, 'utf8');
  }
  contents = upsertEnvLine(contents, 'CONTEXT_EXTRA_ROOTS', serializeColonPaths(roots));
  fs.mkdirSync(envRoot, { recursive: true });
  fs.writeFileSync(envPath, contents, 'utf8');
}

function contextBindLine(root: string): string {
  return `      - ${JSON.stringify(`${root}:${root}:ro`)}`;
}

function overrideHasBind(text: string, root: string): boolean {
  return text.includes(`${root}:${root}`);
}

/** Identity :ro binds for the live sibling stack (automatic override.yml). */
export function upsertHermesContextOverrideBinds(
  roots: readonly string[],
  assistantRoot: string
): string {
  const overridePath = path.join(assistantRoot, 'docker-compose.override.yml');
  const examplePath = path.join(assistantRoot, 'docker-compose.override.yml.example');
  let text = '';
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
  const needed = roots.filter((root) => !overrideHasBind(text, root));
  if (needed.length === 0) {
    return overridePath;
  }
  const lines = text.split(/(?<=\n)/);
  let hermesIdx = lines.findIndex((line) => line.replace(/\n$/, '') === '  hermes:');
  if (hermesIdx < 0) {
    if (text.length > 0 && !text.endsWith('\n')) {
      lines.push('\n');
    }
    lines.push('  hermes:\n', '    volumes:\n');
    hermesIdx = lines.length - 2;
  }
  let volIdx = -1;
  for (let i = hermesIdx + 1; i < lines.length; i += 1) {
    const trimmed = lines[i]?.replace(/\n$/, '') ?? '';
    if (/^  [a-zA-Z0-9_-]+:\s*$/.test(trimmed) && !trimmed.startsWith('    ')) {
      break;
    }
    if (trimmed === '    volumes:') {
      volIdx = i;
      break;
    }
  }
  const insertAt = volIdx >= 0 ? volIdx + 1 : hermesIdx + 1;
  if (volIdx < 0) {
    lines.splice(insertAt, 0, '    volumes:\n');
  }
  const bindAt = volIdx >= 0 ? insertAt : insertAt + 1;
  lines.splice(bindAt, 0, ...needed.map((root) => `${contextBindLine(root)}\n`));
  fs.writeFileSync(overridePath, lines.join(''), 'utf8');
  return overridePath;
}
