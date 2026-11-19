/**
 * Shared stand-ins for AssistantStackService tests: the container runtime (no Docker), the
 * stack root and the compose paths Boundary passes. `vi.mock` stays in each test file; the
 * factories come from here. Create the fakes with `vi.hoisted` so the factories can reach them:
 *
 *   const fakes = await vi.hoisted(async () => (await import('./stackServiceMocks')).createComposeFakes());
 *   vi.mock('../../containerRuntime', async (importOriginal) =>
 *     (await import('./stackServiceMocks')).containerRuntimeMock(await importOriginal(), fakes));
 */
import { vi, type Mock } from 'vitest';
import type * as ContainerRuntimeModule from '../../containerRuntime';
import type { ContainerRuntime } from '../../containerRuntime';

/** The fixed stack root, outside any real install. */
export const STACK_ROOT = '/tmp/boundary-project';

export interface ComposeFakes {
  getContainerRuntime: Mock;
  runCompose: Mock;
  runComposeStreaming: Mock;
  runCli: Mock;
}

export function createComposeFakes(): ComposeFakes {
  return {
    getContainerRuntime: vi.fn(),
    runCompose: vi.fn(),
    runComposeStreaming: vi.fn(),
    runCli: vi.fn(),
  };
}

/** The real containerRuntime module with its four Docker calls sent to the fakes. */
export function containerRuntimeMock(actual: typeof ContainerRuntimeModule, fakes: ComposeFakes) {
  return {
    ...actual,
    getContainerRuntime: (...args: unknown[]) => fakes.getContainerRuntime(...args),
    runCompose: (...args: unknown[]) => fakes.runCompose(...args),
    runComposeStreaming: (...args: unknown[]) => fakes.runComposeStreaming(...args),
    runCli: (...args: unknown[]) => fakes.runCli(...args),
  };
}

/** A system Docker install for `getContainerRuntime` to resolve to. */
export function dockerRuntime(
  options: { env?: NodeJS.ProcessEnv; compose?: string } = {}
): ContainerRuntime {
  return {
    kind: 'docker',
    origin: 'system',
    cliPath: 'docker',
    composeArgv: ['compose'],
    env: options.env ?? {},
    apiEndpoint: 'unix:///var/run/docker.sock',
    version: { cli: '1', compose: options.compose ?? '2.38.2' },
  };
}

/** `resolveAssistantRoot` answering `root()` with no error. */
export function resolveAssistantRootMock(root: () => string) {
  return {
    tryResolveAssistantRoot: () => ({ root: root(), error: undefined as string | undefined }),
    resolveAssistantRoot: () => root(),
  };
}

/** The `assistantPaths` functions every compose call reads: overlay, workspace, OpenCode config. */
export function composePathMocks() {
  return {
    resolveBoundaryOverlayPath: () => '/tmp/docker-compose.boundary.yml',
    resolveAssistantWorkspaceRoot: () => '/tmp/assistant-workspace',
    ensureOpenCodeConfigFile: async () => '/tmp/opencode.json',
  };
}

export interface ComposeCall {
  args: string[];
  /** Every `--profile` the call names. */
  profiles: string[];
  /** The compose subcommand (`up`, `rm` or `run`) and what follows it. */
  command: string[];
  env: NodeJS.ProcessEnv;
}

/** Each call made to a fake `runCompose`, split into profiles, subcommand and env. */
export function composeCalls(runCompose: Mock): ComposeCall[] {
  return runCompose.mock.calls.map((call) => {
    const args = call[1] as string[];
    const profiles = args.flatMap((arg, i) => (args[i - 1] === '--profile' ? [arg] : []));
    const at = args.findIndex((arg) => ['up', 'rm', 'run'].includes(arg));
    return { args, profiles, command: args.slice(at), env: (call[2] as { env: NodeJS.ProcessEnv }).env };
  });
}
