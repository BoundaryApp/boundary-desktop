import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CREDENTIALS_BROWSER_PATH } from './requestGuard';

/**
 * The browser relay's credential client (ADR 0065): the stack's Bitwarden broker connects with a
 * token of its own to fill a login or hand over a sign-in session in a page the agent opened.
 *
 * The broker's provider table (stack `compose/bitwarden-broker/broker/browsers.py`) names
 * Boundary's relay as `boundary` and reads two files on every call, from the Bitwarden add-on's
 * `secrets` folder (mounted read-only at `/secrets`): `boundary.url`, the endpoint without a
 * token or query, and `boundary.token`. One value each, no whitespace inside. Because they are
 * read per call, a new port or token needs no stack restart. Neither value is ever logged.
 */

export const CREDENTIAL_URL_FILE = 'boundary.url';
export const CREDENTIAL_TOKEN_FILE = 'boundary.token';

/** How often the running bridge replaces the credential token. */
export const CREDENTIAL_ROTATE_MS = 24 * 60 * 60 * 1000;
/**
 * How long the previous token still opens the relay after a rotation: a fill whose broker read the
 * file just before the new one landed still connects.
 */
export const CREDENTIAL_GRACE_MS = 60_000;

/** The endpoint the broker opens; it appends `?token=` itself. */
export function credentialClientUrl(browserPort: number): string {
  return `ws://host.docker.internal:${browserPort}${CREDENTIALS_BROWSER_PATH}`;
}

export function newCredentialToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface CredentialTokenOptions {
  /** Called with the accepted tokens (current first) and the current one, after every change. */
  onChange(accepted: string[], current: string): void;
  newToken?: () => string;
  rotateEveryMs?: number;
  graceMs?: number;
}

/**
 * The credential client's token for one run of the bridge. It lives in memory and in the token
 * file only: a new bridge starts with a new one, and while it runs it is replaced every
 * {@link CREDENTIAL_ROTATE_MS}, apart from the agent's token.
 */
export class CredentialTokens {
  private currentToken: string;
  private previous: string | null = null;
  private rotateTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private readonly newToken: () => string;

  constructor(private readonly options: CredentialTokenOptions) {
    this.newToken = options.newToken ?? newCredentialToken;
    this.currentToken = this.newToken();
  }

  get current(): string {
    return this.currentToken;
  }

  /** Current first, then the previous one while its grace lasts. */
  get accepted(): string[] {
    return this.previous ? [this.currentToken, this.previous] : [this.currentToken];
  }

  /** Begin the rotation schedule. */
  start(): void {
    if (this.rotateTimer) return;
    this.rotateTimer = setInterval(() => this.rotate(), this.options.rotateEveryMs ?? CREDENTIAL_ROTATE_MS);
    this.rotateTimer.unref?.();
  }

  /** Replace the token now. The old one is accepted for the grace period, then dropped. */
  rotate(): void {
    this.previous = this.currentToken;
    this.currentToken = this.newToken();
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.previous = null;
      this.options.onChange(this.accepted, this.currentToken);
    }, this.options.graceMs ?? CREDENTIAL_GRACE_MS);
    this.graceTimer.unref?.();
    this.options.onChange(this.accepted, this.currentToken);
  }

  stop(): void {
    if (this.rotateTimer) clearInterval(this.rotateTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.rotateTimer = null;
    this.graceTimer = null;
    this.previous = null;
  }
}

/**
 * Replace `name` in `dir` with `value` in one step: a new file of mode 0600 is written beside it
 * and renamed over it, so the broker never reads a half-written value.
 */
async function writeSecretFile(dir: string, name: string, value: string): Promise<void> {
  const target = path.join(dir, name);
  const temp = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(temp, `${value}\n`, { mode: 0o600, flag: 'wx' });
    // writeFile's mode is masked by umask; 0600 is narrower than any umask leaves, but say it anyway.
    await fs.promises.chmod(temp, 0o600);
    await fs.promises.rename(temp, target);
  } catch (err) {
    await fs.promises.rm(temp, { force: true }).catch((): void => undefined);
    throw err;
  }
}

export type CredentialFilesResult = 'written' | 'no-folder';

/**
 * Write the endpoint and the token into the add-on's `secrets` folder. The folder is the add-on's
 * own (its setup makes it); when it doesn't exist the add-on isn't set up and nothing is written.
 */
export async function writeCredentialClientFiles(
  secretsDir: string,
  values: { url: string; token: string }
): Promise<CredentialFilesResult> {
  if (/\s/.test(values.url) || /\s/.test(values.token) || !values.url || !values.token) {
    throw new Error('The credential client endpoint and token must be single words.');
  }
  const folder = await fs.promises.stat(secretsDir).catch((): null => null);
  if (!folder?.isDirectory()) return 'no-folder';
  await writeSecretFile(secretsDir, CREDENTIAL_TOKEN_FILE, values.token);
  await writeSecretFile(secretsDir, CREDENTIAL_URL_FILE, values.url);
  return 'written';
}

/** Remove both files, so no token outlives the bridge that accepted it. Missing files are fine. */
export async function removeCredentialClientFiles(secretsDir: string): Promise<void> {
  await Promise.all(
    [CREDENTIAL_TOKEN_FILE, CREDENTIAL_URL_FILE].map((name) => fs.promises.rm(path.join(secretsDir, name), { force: true }))
  );
}
