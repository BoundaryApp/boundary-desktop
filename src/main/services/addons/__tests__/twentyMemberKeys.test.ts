import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintMemberKeys, revokeMemberKeys, TwentyKeyError, TWENTY_ROLE_LABELS } from '../twentyMemberKeys';
import { signedInLocalSettings, writeTwentyWorkspace, twentyWorkspacesDir } from './twentyStoreFixtures';

import { localStackEndpoints } from '../../stackHost/localStackHost';
import { DEFAULT_ASSISTANT_STACK_PORTS } from '../../../../shared/assistantStackConstants';

const endpoints = localStackEndpoints(() => DEFAULT_ASSISTANT_STACK_PORTS);

const PASSWORD = 'pw-s3cret-value';
const LOGIN_TOKEN = 'login-tok';
const SESSION = 'session-tok';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'twenty-keys-'));
  fs.writeFileSync(path.join(root, '.env'), `TWENTY_USERNAME=owner@example.com\nTWENTY_PASSWORD=${PASSWORD}\n`);
  writeTwentyWorkspace(twentyWorkspacesDir(root), 'main', signedInLocalSettings());
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface Call {
  query: string;
  variables: Record<string, unknown>;
  auth: string | null;
}

/** A fake `/metadata` that answers by operation name, recording each call. */
function fakeTwenty(overrides: Partial<Record<string, (variables: Record<string, unknown>) => unknown>> = {}) {
  const calls: Call[] = [];
  let nextKey = 0;
  const answers: Record<string, (variables: Record<string, unknown>) => unknown> = {
    signIn: () => ({
      data: { signIn: { availableWorkspaces: { availableWorkspacesForSignIn: [{ id: 'ws-1', loginToken: LOGIN_TOKEN }] } } },
    }),
    getAuthTokensFromLoginToken: () => ({
      data: { getAuthTokensFromLoginToken: { tokens: { accessOrWorkspaceAgnosticToken: { token: SESSION } } } },
    }),
    getRoles: () => ({
      data: {
        getRoles: [
          { id: 'role-admin', label: 'Admin' },
          { id: 'role-ro', label: TWENTY_ROLE_LABELS.read },
          { id: 'role-rw', label: TWENTY_ROLE_LABELS.write },
        ],
      },
    }),
    createApiKey: () => ({ data: { createApiKey: { id: `key-${++nextKey}` } } }),
    generateApiKeyToken: (v) => ({ data: { generateApiKeyToken: { token: `token-for-${String(v.k)}` } } }),
    revokeApiKey: (v) => ({ data: { revokeApiKey: { id: (v.i as { id: string }).id } } }),
    ...overrides,
  };
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const headers = init?.headers as Record<string, string>;
    calls.push({ query: body.query, variables: body.variables, auth: headers.authorization ?? null });
    const op = Object.keys(answers).find((name) => body.query.includes(`${name}(`) || body.query.includes(`{ ${name} {`));
    if (!op) throw new Error(`unexpected query ${body.query}`);
    const result = answers[op]!(body.variables);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200 });
  });
  const ops = () => calls.map((call) => Object.keys(answers).find((name) => call.query.includes(name)));
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, ops };
}

describe('mintMemberKeys', () => {
  it('mints one read key against the read-only role, signed in as the owner', async () => {
    const twenty = fakeTwenty();
    const keys = await mintMemberKeys({ root, port: 3000, endpoints, fetchImpl: twenty.fetchImpl }, 'Sam · Book club', 'read');

    expect(keys).toEqual({ read: { id: 'key-1', token: 'token-for-key-1' } });
    expect(twenty.ops()).toEqual(['signIn', 'getAuthTokensFromLoginToken', 'getRoles', 'createApiKey', 'generateApiKeyToken']);
    expect(twenty.calls[0]!.variables).toEqual({ e: 'owner@example.com', p: PASSWORD });
    expect(twenty.calls[1]!.variables).toEqual({ t: LOGIN_TOKEN, o: 'http://localhost:3000' });
    expect(twenty.calls[3]!.variables).toEqual({
      i: { name: 'Sam · Book club', expiresAt: '2126-01-01T00:00:00Z', roleId: 'role-ro' },
    });
    expect(twenty.calls.slice(2).every((call) => call.auth === `Bearer ${SESSION}`)).toBe(true);
  });

  it('mints a read key and a write key for a write grant', async () => {
    const twenty = fakeTwenty();
    const keys = await mintMemberKeys({ root, port: 3000, endpoints, fetchImpl: twenty.fetchImpl }, 'Sam · Book club', 'write');

    expect(keys).toEqual({
      read: { id: 'key-1', token: 'token-for-key-1' },
      write: { id: 'key-2', token: 'token-for-key-2' },
    });
    const roles = twenty.calls.filter((c) => c.query.includes('createApiKey')).map((c) => (c.variables.i as { roleId: string }).roleId);
    expect(roles).toEqual(['role-ro', 'role-rw']);
  });

  it('revokes the read key when the write key fails', async () => {
    let created = 0;
    const twenty = fakeTwenty({
      createApiKey: () => (++created === 1 ? { data: { createApiKey: { id: 'key-1' } } } : { errors: [{ message: 'boom Sam', extensions: { code: 'FORBIDDEN' } }] }),
    });
    const failure = mintMemberKeys({ root, port: 3000, endpoints, fetchImpl: twenty.fetchImpl }, 'Sam', 'write');

    await expect(failure).rejects.toMatchObject({ reason: 'rejected', message: 'Twenty refused the request (FORBIDDEN).' });
    const revoked = twenty.calls.filter((c) => c.query.includes('revokeApiKey')).map((c) => c.variables.i);
    expect(revoked).toEqual([{ id: 'key-1' }]);
  });

  it('revokes a created key whose token never came', async () => {
    const twenty = fakeTwenty({ generateApiKeyToken: () => ({ data: { generateApiKeyToken: null } }) });
    await expect(mintMemberKeys({ root, port: 3000, endpoints, fetchImpl: twenty.fetchImpl }, 'Sam', 'read')).rejects.toMatchObject({
      reason: 'unexpected',
    });
    expect(twenty.calls.filter((c) => c.query.includes('revokeApiKey')).map((c) => c.variables.i)).toEqual([{ id: 'key-1' }]);
  });

  it('says the roles are missing instead of minting against another role', async () => {
    const twenty = fakeTwenty({ getRoles: () => ({ data: { getRoles: [{ id: 'role-admin', label: 'Admin' }] } }) });
    await expect(mintMemberKeys({ root, port: 3000, endpoints, fetchImpl: twenty.fetchImpl }, 'Sam', 'read')).rejects.toMatchObject({
      reason: 'no-role',
    });
    expect(twenty.ops()).not.toContain('createApiKey');
  });

  it('refuses without an owner login, before calling Twenty', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'TWENTY_USERNAME=owner@example.com\n');
    const twenty = fakeTwenty();
    await expect(mintMemberKeys({ root, port: 3000, endpoints, fetchImpl: twenty.fetchImpl }, 'Sam', 'read')).rejects.toMatchObject({
      reason: 'no-login',
    });
    expect(twenty.calls).toHaveLength(0);
  });

  it('says the owner can’t enter the workspace when sign-in lists another one', async () => {
    const twenty = fakeTwenty({
      signIn: () => ({ data: { signIn: { availableWorkspaces: { availableWorkspacesForSignIn: [{ id: 'other', loginToken: 'x' }] } } } }),
    });
    await expect(mintMemberKeys({ root, port: 3000, endpoints, fetchImpl: twenty.fetchImpl }, 'Sam', 'read')).rejects.toMatchObject({
      reason: 'rejected',
    });
  });

  it('reports Twenty down when fetch fails, without repeating the password', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${PASSWORD}`);
    }) as unknown as typeof fetch;
    const error = await mintMemberKeys({ root, port: 3000, endpoints, fetchImpl }, 'Sam', 'read').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TwentyKeyError);
    expect((error as TwentyKeyError).reason).toBe('down');
    expect(String((error as Error).message)).not.toContain(PASSWORD);
  });

  it('keeps only the GraphQL code from an error, never its message', async () => {
    const twenty = fakeTwenty({ signIn: () => ({ errors: [{ message: `Wrong password ${PASSWORD}` }] }) });
    const error = (await mintMemberKeys({ root, port: 3000, endpoints, fetchImpl: twenty.fetchImpl }, 'Sam', 'read').catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('Twenty refused the request.');
  });

  it('treats a 401 as refused', async () => {
    const twenty = fakeTwenty({ signIn: () => new Response('{}', { status: 401 }) });
    await expect(mintMemberKeys({ root, port: 3000, endpoints, fetchImpl: twenty.fetchImpl }, 'Sam', 'read')).rejects.toMatchObject({
      reason: 'rejected',
    });
  });
});

describe('revokeMemberKeys', () => {
  it('revokes each id with one owner session', async () => {
    const twenty = fakeTwenty();
    await revokeMemberKeys({ root, port: 3000, endpoints, fetchImpl: twenty.fetchImpl }, ['key-a', 'key-b']);
    expect(twenty.ops()).toEqual(['signIn', 'getAuthTokensFromLoginToken', 'revokeApiKey', 'revokeApiKey']);
    expect(twenty.calls.slice(2).map((c) => c.variables.i)).toEqual([{ id: 'key-a' }, { id: 'key-b' }]);
  });

  it('does nothing for no ids', async () => {
    const twenty = fakeTwenty();
    await revokeMemberKeys({ root, port: 3000, endpoints, fetchImpl: twenty.fetchImpl }, []);
    expect(twenty.calls).toHaveLength(0);
  });
});
