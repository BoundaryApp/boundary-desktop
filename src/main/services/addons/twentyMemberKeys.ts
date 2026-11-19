/**
 * Twenty API keys for one person a provider shares their local Twenty with (ADR 0048 §4). Signs in
 * as the owner through `/metadata`, as `twentySignIn.ts` and the stack's `twenty_admin.py` do,
 * finds the stack's two roles by label, and mints or revokes keys. Change request 0025 R1 asks the
 * stack for this; until the pinned tag has it, this is Boundary's fallback.
 *
 * Nothing thrown or returned other than the minted token repeats the owner's password, a session
 * token or a key.
 */
import type { ShareLevel } from '../../../shared/serviceOffers';
import { localWorkspaceId, twentyWorkspacesDir } from './twentyWorkspaces';
import { readOwnerLogin } from './twentySignIn';

/** The roles `crm init` makes (`ROLES` in the stack's `twenty_admin.py`). */
export const TWENTY_ROLE_LABELS: Record<ShareLevel, string> = {
  read: 'Hermes read-only',
  write: 'Hermes read-write',
};

/** The expiry `twenty_admin.py` gives its keys (`KEY_EXPIRY`). */
const KEY_EXPIRY = '2126-01-01T00:00:00Z';
const REQUEST_TIMEOUT_MS = 10_000;

const TOKENS = 'tokens { accessOrWorkspaceAgnosticToken { token } }';
const SIGN_IN = `mutation($e: String!, $p: String!) { signIn(email: $e, password: $p) { availableWorkspaces { availableWorkspacesForSignIn { id loginToken } } } }`;
const ACCESS_FROM_LOGIN = `mutation($t: String!, $o: String!) { getAuthTokensFromLoginToken(loginToken: $t, origin: $o) { ${TOKENS} } }`;
const ROLES = 'query { getRoles { id label } }';
const CREATE_KEY = 'mutation($i: CreateApiKeyInput!) { createApiKey(input: $i) { id } }';
const KEY_TOKEN = 'mutation($k: UUID!, $e: String!) { generateApiKeyToken(apiKeyId: $k, expiresAt: $e) { token } }';
const REVOKE_KEY = 'mutation($i: RevokeApiKeyInput!) { revokeApiKey(input: $i) { id } }';

/**
 * Why a call failed: no owner login or local workspace on this Mac, Twenty refused, Twenty didn't
 * answer, a role is missing, or an answer had an unexpected shape.
 */
export type TwentyKeyFailure = 'no-login' | 'rejected' | 'down' | 'no-role' | 'unexpected';

export class TwentyKeyError extends Error {
  constructor(readonly reason: TwentyKeyFailure, message: string) {
    super(message);
    this.name = 'TwentyKeyError';
  }
}

export interface TwentyKeyDeps {
  /** The stack's checkout or tree, holding `.env`; the Twenty add-on store follows from it. */
  root: string;
  port: number;
  fetchImpl?: typeof fetch;
}

export interface MintedKey {
  id: string;
  token: string;
}

/** A grant's keys. A `write` grant has both, so unattended runs keep a read key (spec decision 3). */
export interface MemberKeys {
  read: MintedKey;
  write?: MintedKey;
}

type Gql = (query: string, variables?: Record<string, unknown>, token?: string) => Promise<Record<string, unknown>>;

function graphql(deps: TwentyKeyDeps): Gql {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async (query, variables, token) => {
    let response: Response;
    try {
      response = await fetchImpl(`http://127.0.0.1:${deps.port}/metadata`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // A redirect would carry the password or session on to wherever it points.
        redirect: 'error',
      });
    } catch {
      throw new TwentyKeyError('down', 'Twenty isn’t answering.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new TwentyKeyError('rejected', `Twenty refused the request (HTTP ${response.status}).`);
    }
    let body: { data?: unknown; errors?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new TwentyKeyError('unexpected', 'Twenty answered with something that isn’t JSON.');
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      // Error messages can quote input, so only the GraphQL code is kept.
      const code = (body.errors[0] as { extensions?: { code?: unknown } })?.extensions?.code;
      throw new TwentyKeyError('rejected', `Twenty refused the request${typeof code === 'string' ? ` (${code})` : ''}.`);
    }
    if (!response.ok || typeof body.data !== 'object' || body.data === null) {
      throw new TwentyKeyError('unexpected', `Twenty answered HTTP ${response.status} without data.`);
    }
    return body.data as Record<string, unknown>;
  };
}

function pick(data: unknown, ...path: string[]): unknown {
  let at = data;
  for (const key of path) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

function str(data: unknown, ...path: string[]): string {
  const value = pick(data, ...path);
  if (typeof value !== 'string' || !value) {
    throw new TwentyKeyError('unexpected', `Twenty’s answer has no ${path.join('.')}.`);
  }
  return value;
}

/** An access token for the local workspace, signed in as its owner. */
async function ownerSession(deps: TwentyKeyDeps, gql: Gql): Promise<string> {
  const login = readOwnerLogin(deps.root);
  const workspace = localWorkspaceId(twentyWorkspacesDir(deps.root));
  if (!login || !workspace) {
    throw new TwentyKeyError('no-login', 'This Mac has no Twenty owner login or local workspace.');
  }
  const signedIn = await gql(SIGN_IN, { e: login.username, p: login.password });
  const available = pick(signedIn, 'signIn', 'availableWorkspaces', 'availableWorkspacesForSignIn');
  const match = Array.isArray(available)
    ? (available as Array<{ id?: unknown; loginToken?: unknown }>).find((w) => w.id === workspace.id)
    : undefined;
  if (typeof match?.loginToken !== 'string' || !match.loginToken) {
    throw new TwentyKeyError('rejected', 'The owner account can’t enter this Mac’s workspace.');
  }
  const origin = (workspace.workspaceUrl || `http://localhost:${deps.port}`).replace(/\/+$/, '');
  const access = await gql(ACCESS_FROM_LOGIN, { t: match.loginToken, o: origin });
  return str(access, 'getAuthTokensFromLoginToken', 'tokens', 'accessOrWorkspaceAgnosticToken', 'token');
}

async function roleIds(gql: Gql, session: string): Promise<Record<ShareLevel, string>> {
  const data = await gql(ROLES, undefined, session);
  const roles = pick(data, 'getRoles');
  if (!Array.isArray(roles)) throw new TwentyKeyError('unexpected', 'Twenty’s answer has no getRoles.');
  const byLabel = new Map<string, string>();
  for (const role of roles as Array<{ id?: unknown; label?: unknown }>) {
    if (typeof role.label === 'string' && typeof role.id === 'string') byLabel.set(role.label, role.id);
  }
  const read = byLabel.get(TWENTY_ROLE_LABELS.read);
  const write = byLabel.get(TWENTY_ROLE_LABELS.write);
  if (!read || !write) {
    throw new TwentyKeyError('no-role', 'Twenty is missing the roles setup makes. Run Twenty’s setup again.');
  }
  return { read, write };
}

async function mintOne(gql: Gql, session: string, name: string, roleId: string): Promise<MintedKey> {
  const created = await gql(CREATE_KEY, { i: { name, expiresAt: KEY_EXPIRY, roleId } }, session);
  const id = str(created, 'createApiKey', 'id');
  try {
    const minted = await gql(KEY_TOKEN, { k: id, e: KEY_EXPIRY }, session);
    return { id, token: str(minted, 'generateApiKeyToken', 'token') };
  } catch (error) {
    await gql(REVOKE_KEY, { i: { id } }, session).catch((): void => undefined);
    throw error;
  }
}

/**
 * Mints the keys for one grant, named `name` (what Twenty shows as a record's creator). If any
 * step fails, keys already minted for it are revoked before the error is thrown.
 */
export async function mintMemberKeys(deps: TwentyKeyDeps, name: string, level: ShareLevel): Promise<MemberKeys> {
  const gql = graphql(deps);
  const session = await ownerSession(deps, gql);
  const roles = await roleIds(gql, session);
  const read = await mintOne(gql, session, name, roles.read);
  if (level === 'read') return { read };
  try {
    return { read, write: await mintOne(gql, session, name, roles.write) };
  } catch (error) {
    await gql(REVOKE_KEY, { i: { id: read.id } }, session).catch((): void => undefined);
    throw error;
  }
}

/** Revokes each key by id. Throws on the first one Twenty refuses; ids before it stay revoked. */
export async function revokeMemberKeys(deps: TwentyKeyDeps, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const gql = graphql(deps);
  const session = await ownerSession(deps, gql);
  for (const id of ids) await gql(REVOKE_KEY, { i: { id } }, session);
}
