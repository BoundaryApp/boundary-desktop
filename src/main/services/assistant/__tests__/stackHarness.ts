/**
 * Shared setup for the stack contract suite (`bun run test:stack`, ADR 0031 §1). The suite runs
 * Boundary's own clients against a running agent stack; nothing here runs in the default test
 * run or CI.
 *
 * Which stack:
 *   BOUNDARY_ASSISTANT_ROOT  the stack's compose folder (default: `assistant` beside this checkout)
 *   BOUNDARY_STACK_PORTS     `default-ports` (default) or `offset-ports`
 *   BOUNDARY_STACK_CONTAINER the Hermes container (default: the running `hermes` service of that
 *                            compose folder)
 *   BOUNDARY_STACK_DOCKER    the container CLI (default `docker`)
 *
 * Credentials come from the stack's own files, read by Boundary's helpers
 * (resolveDashboardCredentials, resolveApiServerKey).
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { portsForIsolationMode } from '../../../../shared/assistantStackConstants';
import type {
  AssistantStackIsolationMode,
  AssistantStackPorts,
} from '../../../../shared/types/assistantStack';

export interface StackTarget {
  root: string;
  isolation: AssistantStackIsolationMode;
  ports: AssistantStackPorts;
  container: string;
  docker: string;
}

export type StackProbe = { ok: true; target: StackTarget } | { ok: false; reason: string };

function quietExec(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
  } catch {
    return null;
  }
}

/** `assistant` beside the main checkout, found from git so a worktree resolves it too. */
function defaultStackRoot(): string | null {
  const common = quietExec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
  return common ? path.resolve(path.dirname(common), '..', 'assistant') : null;
}

function findHermesContainer(docker: string, root: string): string | null {
  const out = quietExec(docker, [
    'ps',
    '--filter',
    'label=com.docker.compose.service=hermes',
    '--filter',
    `label=com.docker.compose.project.working_dir=${root}`,
    '--format',
    '{{.Names}}',
  ]);
  return out?.split('\n').map((l) => l.trim()).find(Boolean) ?? null;
}

/** Resolve the stack from the environment, without contacting it. */
export function resolveStackTarget(): StackProbe {
  const root = process.env.BOUNDARY_ASSISTANT_ROOT?.trim() || defaultStackRoot();
  if (!root || !fs.existsSync(path.join(root, 'docker-compose.yml'))) {
    return {
      ok: false,
      reason: `no stack folder (set BOUNDARY_ASSISTANT_ROOT; looked at ${root ?? 'nothing'})`,
    };
  }
  const isolation: AssistantStackIsolationMode =
    process.env.BOUNDARY_STACK_PORTS === 'offset-ports' ? 'offset-ports' : 'default-ports';
  const docker = process.env.BOUNDARY_STACK_DOCKER?.trim() || 'docker';
  const container =
    process.env.BOUNDARY_STACK_CONTAINER?.trim() || findHermesContainer(docker, root);
  if (!container) {
    return { ok: false, reason: `no running hermes container for ${root} (set BOUNDARY_STACK_CONTAINER)` };
  }
  const running = quietExec(docker, ['inspect', '-f', '{{.State.Running}}', container])?.trim();
  if (running !== 'true') {
    return { ok: false, reason: `container ${container} isn't running` };
  }
  return {
    ok: true,
    target: { root, isolation, ports: portsForIsolationMode(isolation), container, docker },
  };
}

/** The resolved stack, once its dashboard answers HTTP. Says why when it isn't reachable. */
export async function probeStack(): Promise<StackProbe> {
  const probe = await reachStack();
  if (!probe.ok) console.warn(`[test:stack] skipping: ${probe.reason}`);
  return probe;
}

async function reachStack(): Promise<StackProbe> {
  const resolved = resolveStackTarget();
  if (!resolved.ok) return resolved;
  const url = `http://127.0.0.1:${resolved.target.ports.dashboard}/`;
  try {
    await fetch(url, { signal: AbortSignal.timeout(5_000) });
  } catch {
    return { ok: false, reason: `the dashboard at ${url} doesn't answer` };
  }
  return resolved;
}

/** Title suffix that says why a file's checks were skipped. */
export function skipNote(probe: StackProbe): string {
  return probe.ok ? '' : ` (skipped: ${probe.reason})`;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run a command in the Hermes container with `input` on stdin. Resolves with the exit code; the
 * child is stopped by its own PID on timeout.
 */
export function execInHermes(
  target: StackTarget,
  command: string[],
  options: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {}
): Promise<ExecResult> {
  const envArgs = Object.entries(options.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const child = spawn(target.docker, ['exec', '-i', ...envArgs, target.container, ...command], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  child.stdin.end(options.input ?? '');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? 60_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Run a Python program in the container; it prints one JSON line last. */
export async function pythonJsonInHermes<T>(
  target: StackTarget,
  program: string,
  options: { env?: Record<string, string> } = {}
): Promise<T> {
  const out = await execInHermes(target, ['python3', '-'], { input: program, env: options.env });
  const last = out.stdout.trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(last) as T;
  } catch {
    const errLine = out.stderr.trim().split('\n').at(-1) ?? '';
    throw new Error(`python in ${target.container} exited ${out.code} without a result: ${errLine}`);
  }
}
