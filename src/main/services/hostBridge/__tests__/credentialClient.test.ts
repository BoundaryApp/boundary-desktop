import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_GRACE_MS,
  CREDENTIAL_ROTATE_MS,
  CREDENTIAL_TOKEN_FILE,
  CREDENTIAL_URL_FILE,
  credentialClientUrl,
  CredentialTokens,
  newCredentialToken,
  removeCredentialClientFiles,
  writeCredentialClientFiles,
} from '../credentialClient';

describe('credentialClientUrl', () => {
  it("is an endpoint the broker accepts: ws, a port, /devtools/browser/<name>, no query", () => {
    const url = credentialClientUrl(51234);
    expect(url).toBe('ws://host.docker.internal:51234/devtools/browser/credentials');
    // The broker's valid_endpoint (stack compose/bitwarden-broker/broker/cdp.py, _BROWSER_PATH).
    const parsed = new URL(url);
    expect(parsed.protocol).toBe('ws:');
    expect(parsed.port).toBe('51234');
    expect(parsed.pathname).toMatch(/^\/devtools\/browser\/[A-Za-z0-9_-]{1,64}$/);
    expect(parsed.search).toBe('');
  });

  it('makes tokens of 256 bits with no characters a URL or the file would need escaped', () => {
    const token = newCredentialToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newCredentialToken()).not.toBe(token);
  });
});

describe('CredentialTokens', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function tokens() {
    let n = 0;
    const onChange = vi.fn();
    const t = new CredentialTokens({ onChange, newToken: () => `tok-${++n}` });
    return { t, onChange };
  }

  it('starts with one token and rotates on its schedule, keeping the old one for the grace period', () => {
    const { t, onChange } = tokens();
    expect(t.accepted).toEqual(['tok-1']);
    t.start();
    vi.advanceTimersByTime(CREDENTIAL_ROTATE_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.current).toBe('tok-2');
    expect(onChange).toHaveBeenLastCalledWith(['tok-2', 'tok-1'], 'tok-2');
    vi.advanceTimersByTime(CREDENTIAL_GRACE_MS);
    expect(onChange).toHaveBeenLastCalledWith(['tok-2'], 'tok-2');
    expect(t.accepted).toEqual(['tok-2']);
    vi.advanceTimersByTime(CREDENTIAL_ROTATE_MS - CREDENTIAL_GRACE_MS);
    expect(t.current).toBe('tok-3');
  });

  it('accepts only the newest previous token when rotated twice inside one grace period', () => {
    const { t } = tokens();
    t.rotate();
    t.rotate();
    expect(t.accepted).toEqual(['tok-3', 'tok-2']);
    vi.advanceTimersByTime(CREDENTIAL_GRACE_MS);
    expect(t.accepted).toEqual(['tok-3']);
  });

  it('stops rotating and drops the previous token when stopped', () => {
    const { t, onChange } = tokens();
    t.start();
    t.rotate();
    onChange.mockClear();
    t.stop();
    expect(t.accepted).toEqual(['tok-2']);
    vi.advanceTimersByTime(CREDENTIAL_ROTATE_MS * 3);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('credential client files', () => {
  let root: string;
  let secrets: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-client-'));
    secrets = path.join(root, 'secrets');
    fs.mkdirSync(secrets, { mode: 0o711 });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const read = (name: string) => fs.readFileSync(path.join(secrets, name), 'utf8');
  const mode = (name: string) => fs.statSync(path.join(secrets, name)).mode & 0o777;

  it('writes one value per file, mode 0600, with no temp file left behind', async () => {
    const url = credentialClientUrl(40001);
    expect(await writeCredentialClientFiles(secrets, { url, token: 'tok-a' })).toBe('written');
    expect(read(CREDENTIAL_URL_FILE)).toBe(`${url}\n`);
    expect(read(CREDENTIAL_TOKEN_FILE)).toBe('tok-a\n');
    expect(mode(CREDENTIAL_URL_FILE)).toBe(0o600);
    expect(mode(CREDENTIAL_TOKEN_FILE)).toBe(0o600);
    expect(fs.readdirSync(secrets).sort()).toEqual([CREDENTIAL_TOKEN_FILE, CREDENTIAL_URL_FILE].sort());
  });

  it('replaces both on rotation and port change, by rename, keeping 0600', async () => {
    await writeCredentialClientFiles(secrets, { url: credentialClientUrl(40001), token: 'tok-a' });
    const before = fs.statSync(path.join(secrets, CREDENTIAL_TOKEN_FILE)).ino;
    // A file someone loosened is replaced, not rewritten in place.
    fs.chmodSync(path.join(secrets, CREDENTIAL_TOKEN_FILE), 0o644);
    await writeCredentialClientFiles(secrets, { url: credentialClientUrl(40002), token: 'tok-b' });
    expect(read(CREDENTIAL_TOKEN_FILE)).toBe('tok-b\n');
    expect(read(CREDENTIAL_URL_FILE)).toBe('ws://host.docker.internal:40002/devtools/browser/credentials\n');
    expect(fs.statSync(path.join(secrets, CREDENTIAL_TOKEN_FILE)).ino).not.toBe(before);
    expect(mode(CREDENTIAL_TOKEN_FILE)).toBe(0o600);
    expect(fs.readdirSync(secrets)).toHaveLength(2);
  });

  it("writes nothing, and makes no folder, when the add-on's secrets folder doesn't exist", async () => {
    const missing = path.join(root, 'not-set-up', 'secrets');
    expect(await writeCredentialClientFiles(missing, { url: credentialClientUrl(1), token: 't' })).toBe('no-folder');
    expect(fs.existsSync(path.join(root, 'not-set-up'))).toBe(false);
  });

  it('refuses a value with whitespace, which the broker would read as no value', async () => {
    await expect(writeCredentialClientFiles(secrets, { url: credentialClientUrl(1), token: 'a b' })).rejects.toThrow(/single words/);
    await expect(writeCredentialClientFiles(secrets, { url: '', token: 't' })).rejects.toThrow(/single words/);
    expect(fs.readdirSync(secrets)).toEqual([]);
  });

  it('removes both files, and is fine when they are already gone', async () => {
    await writeCredentialClientFiles(secrets, { url: credentialClientUrl(1), token: 't' });
    await removeCredentialClientFiles(secrets);
    expect(fs.readdirSync(secrets)).toEqual([]);
    await expect(removeCredentialClientFiles(secrets)).resolves.toBeUndefined();
    await expect(removeCredentialClientFiles(path.join(root, 'missing'))).resolves.toBeUndefined();
  });
});
