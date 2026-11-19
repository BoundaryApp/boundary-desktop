import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyOwnerPassword, readOwnerLogin, twentyLoginLink } from '../twentySignIn';
import { twentyWorkspacesDir } from '../twentyWorkspaces';
import { signedInLocalSettings, writeTwentyWorkspace } from './twentyStoreFixtures';

const PASSWORD = 'pw-s3cret-value';
const TOKEN = 'tok/en+1=';
const WARN_REJECTED = 'Twenty didn’t accept the saved owner login, so it opens at its sign-in page.';
const WARN_DOWN = 'Twenty isn’t answering, so it opens without signing in.';

let root: string;

function writeEnv(lines: string[]): void {
  fs.writeFileSync(path.join(root, '.env'), lines.join('\n') + '\n');
}

function writeWorkspace(id = 'ws-1', url = 'http://localhost:3000/'): void {
  writeTwentyWorkspace(twentyWorkspacesDir(root), 'main', signedInLocalSettings(id, url));
}

const answer = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

const signInBody = (id = 'ws-1') => ({
  data: {
    signIn: {
      availableWorkspaces: { availableWorkspacesForSignIn: [{ id, loginToken: TOKEN }] },
    },
  },
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'twenty-signin-'));
  writeEnv(['TWENTY_USERNAME=owner@example.com', `TWENTY_PASSWORD=${PASSWORD}`]);
  writeWorkspace();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('readOwnerLogin', () => {
  it('reads the username and password from .env', () => {
    expect(readOwnerLogin(root)).toEqual({ username: 'owner@example.com', password: PASSWORD });
  });

  it('reads TWENTY_PASSWORD_FILE relative to the root, trimmed', () => {
    fs.mkdirSync(path.join(root, 'secrets'));
    fs.writeFileSync(path.join(root, 'secrets', 'twenty'), `  ${PASSWORD}\n`);
    writeEnv(['TWENTY_USERNAME=owner@example.com', 'TWENTY_PASSWORD_FILE=secrets/twenty']);
    expect(readOwnerLogin(root)).toEqual({ username: 'owner@example.com', password: PASSWORD });
  });

  it('reads an absolute TWENTY_PASSWORD_FILE', () => {
    const file = path.join(root, 'abs-pw');
    fs.writeFileSync(file, PASSWORD);
    writeEnv(['TWENTY_USERNAME=owner@example.com', `TWENTY_PASSWORD_FILE=${file}`]);
    expect(readOwnerLogin(root)?.password).toBe(PASSWORD);
  });

  it('is null without a username, a password, or a readable password file', () => {
    writeEnv(['TWENTY_PASSWORD=x']);
    expect(readOwnerLogin(root)).toBeNull();
    writeEnv(['TWENTY_USERNAME=a@example.com']);
    expect(readOwnerLogin(root)).toBeNull();
    writeEnv(['TWENTY_USERNAME=a@example.com', 'TWENTY_PASSWORD_FILE=missing']);
    expect(readOwnerLogin(root)).toBeNull();
    fs.rmSync(path.join(root, '.env'));
    expect(readOwnerLogin(root)).toBeNull();
  });
});

describe('twentyLoginLink', () => {
  it('builds the verify link from the matching workspace and posts to /metadata', async () => {
    const fetchImpl = answer(signInBody());
    const result = await twentyLoginLink({ root, port: 3000, fetchImpl });
    expect(result).toEqual({
      url: `http://localhost:3000/verify?loginToken=${encodeURIComponent(TOKEN)}`,
      signedIn: true,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3000/metadata');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const sent = JSON.parse(init.body as string);
    expect(sent.query).toContain('signIn(email: $e, password: $p)');
    expect(sent.variables).toEqual({ e: 'owner@example.com', p: PASSWORD });
  });

  it('refuses redirects, so the password goes only to Twenty', async () => {
    const fetchImpl = answer(signInBody());
    await twentyLoginLink({ root, port: 3000, fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe('error');
  });

  it('adds a slash when the workspace address lacks one', async () => {
    writeWorkspace('ws-1', 'http://localhost:3000');
    const result = await twentyLoginLink({ root, port: 3000, fetchImpl: answer(signInBody()) });
    expect(result.url).toMatch(/^http:\/\/localhost:3000\/verify\?loginToken=/);
  });

  it('uses the given port for the request', async () => {
    const fetchImpl = answer(signInBody());
    await twentyLoginLink({ root, port: 3456, fetchImpl });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('http://127.0.0.1:3456/metadata');
  });

  const plain = { url: 'http://localhost:3000/', signedIn: false };
  it.each([
    ['a workspace id that does not match', answer(signInBody('other')), WARN_REJECTED, 'rejected'],
    ['HTTP 500', answer({}, 500), WARN_REJECTED, 'rejected'],
    ['GraphQL errors', answer({ errors: [{ message: `bad ${PASSWORD}` }] }), WARN_REJECTED, 'rejected'],
    ['an unreadable body', vi.fn(async () => new Response('<html>', { status: 200 })), WARN_REJECTED, 'rejected'],
    ['a thrown fetch', vi.fn(async () => { throw new Error(`down ${PASSWORD} ${TOKEN}`); }), WARN_DOWN, 'down'],
  ])('gives the plain address and a warning for %s', async (_name, fetchImpl, warning, reason) => {
    const result = await twentyLoginLink({ root, port: 3000, fetchImpl: fetchImpl as never });
    expect(result).toEqual({ ...plain, warning, reason });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('warns that the login was not accepted when .env has no owner login', async () => {
    fs.rmSync(path.join(root, '.env'));
    const fetchImpl = answer(signInBody());
    const result = await twentyLoginLink({ root, port: 3000, fetchImpl });
    expect(result).toEqual({ ...plain, warning: WARN_REJECTED, reason: 'rejected' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to localhost on the port when no workspace address is recorded', async () => {
    fs.rmSync(twentyWorkspacesDir(root), { recursive: true });
    const result = await twentyLoginLink({ root, port: 3100, fetchImpl: answer(signInBody()) });
    expect(result.url).toBe('http://localhost:3100/');
    expect(result.signedIn).toBe(false);
  });
});

describe('copyOwnerPassword', () => {
  function fakeClipboard() {
    let text = '';
    return {
      writeText: vi.fn((t: string) => { text = t; }),
      readText: vi.fn(() => text),
    };
  }

  it('copies the password and clears it after exactly 60 000 ms', async () => {
    vi.useFakeTimers();
    const clipboard = fakeClipboard();
    expect(copyOwnerPassword({ root, clipboard })).toBe(true);
    expect(clipboard.readText()).toBe(PASSWORD);
    vi.advanceTimersByTime(59_999);
    expect(clipboard.readText()).toBe(PASSWORD);
    await vi.advanceTimersByTimeAsync(1);
    expect(clipboard.readText()).toBe('');
  });

  it('leaves the clipboard alone when it holds something else by then', async () => {
    vi.useFakeTimers();
    const clipboard = fakeClipboard();
    copyOwnerPassword({ root, clipboard });
    clipboard.writeText('something else');
    clipboard.writeText.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(clipboard.readText()).toBe('something else');
  });

  it('returns false and writes nothing without an owner login', () => {
    fs.rmSync(path.join(root, '.env'));
    const clipboard = fakeClipboard();
    expect(copyOwnerPassword({ root, clipboard })).toBe(false);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
});
