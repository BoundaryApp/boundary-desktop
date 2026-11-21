import fs from 'node:fs';
import path from 'node:path';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import type { ProjectEnv } from '../projectEnv';
import { resolveAssistantStackHome } from '../assistantPaths';
import { listStoredHermesProjects } from '../hermes/hermesProjectStore';
import {
  codingPathAliases,
  codingRootsFromPaths,
  envShadowTargets,
  serializeCodingExtraRoots,
  stackCheckoutDataDirs,
} from './codingGrantRules';
import { listCodingGrantRecords } from './codingGrantStore';

/** What the projects overlay mounts for the coding agent (ADR 0028 §4, §6). */
export interface CodingMounts {
  /** Identity read-write binds on `opencode` and the terminal service. */
  roots: string[];
  /** Files hidden behind an empty read-only file. */
  shadows: string[];
  /** The empty file every shadow points at. */
  shadowSource: string;
}

/** Every granted folder: grant records plus project folders with coding on. */
export function codingGrantPaths(
  projects: readonly HermesProjectRecord[] = listStoredHermesProjects()
): string[] {
  const hubs = projects
    .filter((project) => project.kind === 'host-folder' && project.codingEnabled)
    .map((project) => project.hostPath);
  return [...listCodingGrantRecords().map((grant) => grant.resource), ...hubs];
}

export function currentCodingRoots(
  projects: readonly HermesProjectRecord[] = listStoredHermesProjects()
): string[] {
  return codingRootsFromPaths(codingGrantPaths(projects));
}

function resolveCodingShadowSource(): string {
  return path.join(resolveAssistantStackHome(), 'coding', 'empty-env');
}

export function ensureCodingShadowSource(source = resolveCodingShadowSource()): string {
  fs.mkdirSync(path.dirname(source), { recursive: true });
  if (!fs.existsSync(source)) {
    fs.writeFileSync(source, '', { mode: 0o444 });
  }
  return source;
}

/** Stack checkouts' `data/` folders under mounted folders, each hidden behind an empty folder. */
export interface StackDataMasks {
  /** Host paths of each checkout's `data/`. */
  dataDirs: string[];
  /** The empty read-only folder every mask points at. */
  source: string;
}

function resolveStackDataMaskSource(): string {
  return path.join(resolveAssistantStackHome(), 'coding', 'empty-dir');
}

export function ensureStackDataMaskSource(source = resolveStackDataMaskSource()): string {
  fs.mkdirSync(source, { recursive: true });
  fs.chmodSync(source, 0o555);
  return source;
}

/** A fresh scan of every folder the overlay mounts. Rescanned on every overlay write. */
export function currentStackDataMasks(hostPaths: readonly string[]): StackDataMasks {
  const unique = [...new Set(hostPaths.map((item) => path.resolve(item)))];
  return {
    dataDirs: [...new Set(unique.flatMap((folder) => stackCheckoutDataDirs(folder)))].sort(
      (left, right) => left.localeCompare(right)
    ),
    source: resolveStackDataMaskSource(),
  };
}

/** Roots plus a fresh scan for `.env` files to hide. Rescanned on every overlay write. */
export function currentCodingMounts(
  projects: readonly HermesProjectRecord[] = listStoredHermesProjects()
): CodingMounts {
  const roots = currentCodingRoots(projects);
  return {
    roots,
    shadows: roots.flatMap((root) => envShadowTargets(root)),
    shadowSource: resolveCodingShadowSource(),
  };
}

export function currentCodingPathAliases(
  projects: readonly HermesProjectRecord[] = listStoredHermesProjects()
): string {
  return codingPathAliases(projects);
}

/**
 * The stack variables Boundary owns for coding folders (ADR 0028 §4, change request 0003):
 * the coding roots, "the app will ask" for coding and context roots, and the project aliases.
 */
export function codingStackEnv(
  projects: readonly HermesProjectRecord[] = listStoredHermesProjects(),
  roots: readonly string[] = currentCodingRoots(projects)
): Record<string, string> {
  return {
    CODING_EXTRA_ROOTS: serializeCodingExtraRoots(roots),
    CODING_ROOTS_APP_MANAGED: '1',
    CONTEXT_ROOTS_APP_MANAGED: '1',
    CODING_PATH_ALIASES: currentCodingPathAliases(projects),
  };
}

/** `.env` value: single-quoted so compose takes it literally (no `$` or `#` surprises). */
function envValue(value: string): string {
  return value && /[\s#$"]/.test(value) ? `'${value}'` : value;
}

/**
 * Write the coding variables to the stack `.env`, so a compose run outside Boundary sees the
 * same values. Boundary also passes them in the compose environment, which wins.
 */
export async function persistCodingStackEnv(projectEnv: ProjectEnv, roots?: readonly string[]): Promise<void> {
  const env = codingStackEnv(listStoredHermesProjects(), roots ?? currentCodingRoots());
  await projectEnv.set(Object.fromEntries(Object.entries(env).map(([key, value]) => [key, envValue(value)])));
}
