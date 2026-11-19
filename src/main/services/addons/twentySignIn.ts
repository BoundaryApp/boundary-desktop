import fs from 'node:fs';
import path from 'node:path';
import { readEnvFile } from '../assistant/stackEnv';
import { localWorkspaceId, twentyWorkspacesDir } from './twentyWorkspaces';

const CLIPBOARD_CLEAR_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_PORT = 3000;

const SIGN_IN =
  'mutation($e: String!, $p: String!) { signIn(email: $e, password: $p) { availableWorkspaces { availableWorkspacesForSignIn { id loginToken } } } }';

const WARN_REJECTED = 'Twenty didn’t accept the saved owner login, so it opens at its sign-in page.';
const WARN_DOWN = 'Twenty isn’t answering, so it opens without signing in.';

/** The port Twenty publishes on: `TWENTY_PORT` from the stack's `.env`, 3000 when unset or invalid. */
export function twentyPort(root: string): number {
  const port = Number(readEnvFile(path.join(root, '.env')).TWENTY_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

/**
 * The owner account the stack generated: `TWENTY_USERNAME` and the password from
 * `TWENTY_PASSWORD`, or from the file `TWENTY_PASSWORD_FILE` names (relative to `root` unless
 * absolute). Null when either is missing or empty.
 */
export function readOwnerLogin(root: string): { username: string; password: string } | null {
  const env = readEnvFile(path.join(root, '.env'));
  const username = env.TWENTY_USERNAME?.trim();
  let password = env.TWENTY_PASSWORD?.trim();
  const file = env.TWENTY_PASSWORD_FILE?.trim();
  if (!password && file) {
    try {
      password = fs.readFileSync(path.resolve(root, file), 'utf8').trim();
    } catch {
      password = undefined;
    }
  }
  return username && password ? { username, password } : null;
}

/** Why the open isn't signed in: Twenty refused the login (or answered oddly), or didn't answer. */
export type TwentySignInMiss = 'rejected' | 'down';

export interface TwentyLoginLink {
  url: string;
  signedIn: boolean;
  warning?: string;
  reason?: TwentySignInMiss;
}

export interface TwentyLoginLinkDeps {
  root: string;
  port: number;
  fetchImpl?: typeof fetch;
}

/**
 * The address to open Twenty at. Signs in as the owner through Twenty's `/metadata` GraphQL
 * endpoint, as the stack's `scripts/twenty_admin.py` does, and returns the one-time
 * `/verify?loginToken=` link for the local workspace. On any failure it returns the plain
 * workspace address and a warning. Nothing in the result or in a thrown error repeats the
 * password or the token.
 */
export async function twentyLoginLink(
  deps: TwentyLoginLinkDeps
): Promise<TwentyLoginLink> {
  const { root, port, fetchImpl = fetch } = deps;
  const workspace = localWorkspaceId(twentyWorkspacesDir(root));
  const base = (workspace?.workspaceUrl || `http://localhost:${port}`).replace(/\/+$/, '') + '/';
  const plain = (reason: TwentySignInMiss): TwentyLoginLink => ({
    url: base,
    signedIn: false,
    warning: reason === 'down' ? WARN_DOWN : WARN_REJECTED,
    reason,
  });

  const login = readOwnerLogin(root);
  if (!login || !workspace) return plain('rejected');

  let body: unknown;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/metadata`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: SIGN_IN, variables: { e: login.username, p: login.password } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // A redirect would send the password on to wherever it points.
      redirect: 'error',
    });
    if (!response.ok) return plain('rejected');
    body = await response.json();
  } catch (error) {
    // A body that isn't JSON means something answered, just not Twenty's API.
    return plain(error instanceof SyntaxError ? 'rejected' : 'down');
  }

  const parsed = body as {
    errors?: unknown;
    data?: {
      signIn?: {
        availableWorkspaces?: {
          availableWorkspacesForSignIn?: Array<{ id?: unknown; loginToken?: unknown }>;
        };
      };
    };
  };
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) return plain('rejected');
  const match = parsed.data?.signIn?.availableWorkspaces?.availableWorkspacesForSignIn?.find(
    (w) => w.id === workspace.id
  );
  if (typeof match?.loginToken !== 'string' || !match.loginToken) return plain('rejected');
  return {
    url: `${base}verify?loginToken=${encodeURIComponent(match.loginToken)}`,
    signedIn: true,
  };
}

export interface CopyOwnerPasswordDeps {
  root: string;
  /** Electron's `clipboard`. Its typings make `readText` a promise; the main process returns a string, so both are awaited. */
  clipboard: {
    writeText(text: string): unknown;
    readText(): string | Promise<string>;
  };
  setTimer?: typeof setTimeout;
}

/**
 * Puts the owner password on the clipboard and clears it 60 s later, if the clipboard still
 * holds it by then. False when the stack has no owner login.
 */
export function copyOwnerPassword(deps: CopyOwnerPasswordDeps): boolean {
  const { root, clipboard, setTimer = setTimeout } = deps;
  const login = readOwnerLogin(root);
  if (!login) return false;
  copyThenClear(clipboard, login.password, setTimer);
  return true;
}

/** Puts `text` on the clipboard and clears it 60 s later if the clipboard still holds it. */
export function copyThenClear(
  clipboard: CopyOwnerPasswordDeps['clipboard'],
  text: string,
  setTimer: (fn: () => void, ms: number) => unknown = setTimeout
): void {
  clipboard.writeText(text);
  setTimer(() => {
    void (async (): Promise<void> => {
      if ((await clipboard.readText()) === text) clipboard.writeText('');
    })().catch((): void => undefined);
  }, CLIPBOARD_CLEAR_MS);
}
