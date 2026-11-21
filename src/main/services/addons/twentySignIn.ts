import fs from 'node:fs';
import path from 'node:path';
import { readStackEnv } from '../assistant/stackEnv';
import { stackFilesAt } from '../stackHost/activeStack';
import { localWorkspaceId } from './twentyWorkspaces';
import type { StackEndpoints, StackFiles } from '../stackHost/types';
import { copyThenClear, type SecretClipboard } from './secretClipboard';

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_PORT = 3000;

const SIGN_IN =
  'mutation($e: String!, $p: String!) { signIn(email: $e, password: $p) { availableWorkspaces { availableWorkspacesForSignIn { id loginToken } } } }';

const WARN_REJECTED = 'Twenty didn’t accept the saved owner login, so it opens at its sign-in page.';
const WARN_DOWN = 'Twenty isn’t answering, so it opens without signing in.';

/** The port Twenty publishes on: `TWENTY_PORT` from the stack's `.env`, 3000 when unset or invalid. */
export async function twentyPort(files: StackFiles): Promise<number> {
  const port = Number((await readStackEnv(files, 'stack', '.env')).TWENTY_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

/**
 * The owner account the stack generated: `TWENTY_USERNAME` and the password from
 * `TWENTY_PASSWORD`, or from the file `TWENTY_PASSWORD_FILE` names (relative to `root` unless
 * absolute). Null when either is missing or empty.
 */
export async function readOwnerLogin(
  root: string,
  files: StackFiles = stackFilesAt(root)
): Promise<{ username: string; password: string } | null> {
  const env = await readStackEnv(files, 'stack', '.env');
  const username = env.TWENTY_USERNAME?.trim();
  let password = env.TWENTY_PASSWORD?.trim();
  const file = env.TWENTY_PASSWORD_FILE?.trim();
  if (!password && file) {
    try {
      password = (await readPasswordFile(files, root, file)).trim();
    } catch {
      password = undefined;
    }
  }
  return username && password ? { username, password } : null;
}

/**
 * The file `TWENTY_PASSWORD_FILE` names. A path inside the stack folder is read through
 * `files`; an absolute path elsewhere on this Mac can't be, so it is read directly.
 */
async function readPasswordFile(files: StackFiles, root: string, file: string): Promise<string> {
  const resolved = path.resolve(root, file);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return fs.promises.readFile(resolved, 'utf8');
  const text = await files.readText('stack', rel);
  if (text === null) throw new Error('The password file is missing.');
  return text;
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
  /** Twenty's port as the stack publishes it (`TWENTY_PORT`). */
  port: number;
  /** Turns `port` into a URL on this machine. */
  endpoints: Pick<StackEndpoints, 'portUrl'>;
  fetchImpl?: typeof fetch;
  /** The stack's files; the folder `root` names when omitted. */
  files?: StackFiles;
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
  const { root, port, endpoints, fetchImpl = fetch, files = stackFilesAt(root) } = deps;
  const workspace = await localWorkspaceId(files);
  const base = (workspace?.workspaceUrl || endpoints.portUrl(port, '', 'localhost')).replace(/\/+$/, '') + '/';
  const plain = (reason: TwentySignInMiss): TwentyLoginLink => ({
    url: base,
    signedIn: false,
    warning: reason === 'down' ? WARN_DOWN : WARN_REJECTED,
    reason,
  });

  const login = await readOwnerLogin(root, files);
  if (!login || !workspace) return plain('rejected');

  let body: unknown;
  try {
    const response = await fetchImpl(endpoints.portUrl(port, '/metadata'), {
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
  clipboard: SecretClipboard;
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** The stack's files; the folder `root` names when omitted. */
  files?: StackFiles;
}

/**
 * Puts the owner password on the clipboard and clears it 60 s later, if the clipboard still
 * holds it by then. False when the stack has no owner login.
 */
export async function copyOwnerPassword(deps: CopyOwnerPasswordDeps): Promise<boolean> {
  const { root, clipboard, setTimer = setTimeout, files = stackFilesAt(root) } = deps;
  const login = await readOwnerLogin(root, files);
  if (!login) return false;
  await copyThenClear(clipboard, login.password, setTimer);
  return true;
}
