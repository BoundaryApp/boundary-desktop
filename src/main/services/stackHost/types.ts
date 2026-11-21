import type { StackHostCapabilities } from '../../../shared/stackCapabilities';
import type { AssistantStackPortKey } from '../../../shared/types/assistantStack';

/**
 * Where a stack file lives (ADR 0062 §1). `stack` is the compose folder, `data` its `data/`
 * (Hermes state under `hermes/`), `userContent` the folder `ASSISTANT_DATA_ROOT` names.
 */
export type StackLocation = 'stack' | 'data' | 'userContent';

export interface ComposeOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ComposeStreamingOptions extends ComposeOptions {
  /** Written to stdin. */
  input?: string;
  /** Called with each stdout and stderr line. */
  onLine?: (line: string) => void;
}

export interface RunScriptOptions {
  /** The whole environment of the script; callers build it from `StackCommands.scriptEnv`. */
  env: NodeJS.ProcessEnv;
  /** Written to stdin, which then closes. Without it stdin is ignored. */
  input?: string;
  timeoutMs: number;
  /** Passed to `onStderr` when the time limit stops the script. */
  timeoutLine: string;
  signal?: AbortSignal;
  /** Called with each non-blank stdout line. */
  onStdout(line: string): void;
  /** Called with each non-blank stderr line. */
  onStderr(line: string): void;
}

export interface ScriptComposeOptions {
  /** Added to COMPOSE_PROFILES, as a stack script's `compose_with_profile` adds one. */
  profiles?: string[];
  timeout?: number;
}

export interface StackCommands {
  /** Compose against the stack Boundary talks to. Rejects on a non-zero exit. */
  compose(args: string[], options?: ComposeOptions): Promise<{ stdout: string; stderr: string }>;
  /** Compose that resolves with the exit code; `cancelled` is true when `signal` stopped it. */
  composeStreaming(
    args: string[],
    options?: ComposeStreamingOptions
  ): Promise<{ stdout: string; stderr: string; code: number | null; cancelled: boolean }>;
  /**
   * Environment for a stack script run from the stack folder, whose own `docker compose` calls
   * reach the same project. `profiles` are added to COMPOSE_PROFILES.
   */
  scriptEnv(profiles: string[]): Promise<NodeJS.ProcessEnv>;
  /**
   * Compose from the stack folder with `scriptEnv(profiles)`, so it reaches the project a stack
   * script's own compose calls do. Rejects on a non-zero exit.
   */
  scriptCompose(args: string[], options?: ScriptComposeOptions): Promise<{ stdout: string; stderr: string }>;
  /** The container CLI (`docker` or `podman`) from the stack folder with `scriptEnv([])`. */
  scriptCli(args: string[], options?: { timeout?: number }): Promise<{ stdout: string; stderr: string }>;
  /**
   * Runs `bash <script> <args>` from the stack folder. `script` is relative to it, such as
   * `scripts/addon.sh`. Resolves with the exit code: 124 timed out, 127 bash didn't start,
   * 130 `signal` cancelled it. A timeout or cancel stops bash only; a compose command the
   * script started runs on until it ends.
   */
  runScript(script: string, args: string[], options: RunScriptOptions): Promise<number>;
}

export interface WriteTextOptions {
  /** Mode for a file that doesn't exist yet, such as `0o600` for secrets. */
  mode?: number;
}

export interface StackFileStat {
  /** `other` is a socket, FIFO or device. */
  kind: 'file' | 'folder' | 'other';
  /** Bytes; 0 for a folder on hosts that don't report one. */
  size: number;
}

/** Paths are relative to the location and may not leave it. */
export interface StackFiles {
  /** The file's text, or null when it doesn't exist. */
  readText(location: StackLocation, relPath: string): Promise<string | null>;
  /**
   * Replaces the file in one step, creating its folder. An existing file keeps its mode; a new
   * one gets `options.mode` when given.
   */
  writeText(location: StackLocation, relPath: string, contents: string, options?: WriteTextOptions): Promise<void>;
  /** Like `writeText`, for bytes, such as a sample file copied from this machine. */
  writeBytes(location: StackLocation, relPath: string, data: Uint8Array, options?: WriteTextOptions): Promise<void>;
  exists(location: StackLocation, relPath: string): Promise<boolean>;
  /** What the path is after following links, or null when it doesn't exist. */
  stat(location: StackLocation, relPath: string): Promise<StackFileStat | null>;
  /**
   * The path with every link resolved, relative to the location's own resolved folder (`''`
   * for the folder itself). Null when it doesn't exist or resolves outside the location.
   */
  realpath(location: StackLocation, relPath: string): Promise<string | null>;
  /** Entry names in a folder, or null when it doesn't exist. */
  list(location: StackLocation, relPath: string): Promise<string[] | null>;
  /** Makes the folder and its parents. `mode` applies to the folders this call creates. */
  mkdir(location: StackLocation, relPath: string, options?: { mode?: number }): Promise<void>;
  /** Moves a file or folder within the location. A file at `to` is replaced; a folder there must be empty. */
  rename(location: StackLocation, from: string, to: string): Promise<void>;
  /** Removes a file or folder; nothing happens when it's missing. */
  remove(location: StackLocation, relPath: string): Promise<void>;
}

/** The loopback name a URL uses. Browser addresses for Twenty and Actual use `localhost`. */
export type LoopbackName = '127.0.0.1' | 'localhost';

export interface StackEndpoints {
  /** The port on this machine that reaches one of the stack's stored ports. */
  port(key: AssistantStackPortKey): number;
  /** `http://` URL on this machine for one of the stack's stored ports, with `path` appended. */
  url(key: AssistantStackPortKey, path?: string): string;
  /**
   * `http://` URL on this machine for a port the stack publishes that isn't read from the stored
   * set: a port set being tried, or an add-on's port from the stack's `.env`.
   */
  portUrl(stackPort: number, path?: string, hostname?: LoopbackName): string;
}

export type { StackHostCapabilities } from '../../../shared/stackCapabilities';

export interface StackHost {
  /**
   * `ssh` is a stack on another computer (`sshStackHost.ts`); `fake` is the in-memory host tests
   * use (`fakeStackHost.ts`).
   */
  kind: 'local' | 'ssh' | 'fake';
  commands: StackCommands;
  files: StackFiles;
  endpoints: StackEndpoints;
  capabilities: StackHostCapabilities;
  /**
   * Absolute folders on this machine. Only a local host has them; callers move to `files`
   * (remote stack plan, phase 1c). Reading it on an SSH host throws.
   */
  localPaths: { stack: string; data: string };
}
