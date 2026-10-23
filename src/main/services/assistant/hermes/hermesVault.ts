import type {
  VaultActionResult,
  VaultAddLoginPayload,
  VaultIdentifierType,
  VaultListResult,
  VaultLockPayload,
  VaultLogin,
  VaultRemovePayload,
  VaultReplacePasswordPayload,
  VaultSourcesResult,
  VaultSourceStatus,
  VaultUnlockPayload,
} from '../../../../shared/types/hermesVault';
import { VAULT_IDENTIFIER_TYPES } from '../../../../shared/types/hermesVault';
import { resolveProfileForAgent } from './hermesAgents';
import { getHermesGatewaySession, type HermesVaultMethod } from './hermesGatewaySession';
import { JSON_RPC_METHOD_NOT_FOUND, JsonRpcGatewayError } from './vendor/json-rpc-channel';

/**
 * Passwords & Logins over the Hermes vault RPCs. Each agent's vault lives in its own
 * Hermes profile; the built-in agent uses the default profile.
 *
 * Payloads here can carry a password. Never log a payload, and scrub it from any error
 * text before that text leaves this module.
 */

/** Generous cap; real passwords are far shorter. Matches hermesCredentialRequests. */
const MAX_SECRET_LENGTH = 16 * 1024;
const MAX_TEXT_LENGTH = 512;
const AGENT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

class VaultInputError extends Error {}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

function errorText(err: unknown, secrets: readonly string[] = []): string {
  if (err instanceof VaultInputError) return err.message;
  if (err instanceof JsonRpcGatewayError) {
    if (err.code === JSON_RPC_METHOD_NOT_FOUND) {
      return 'This version of Hermes has no password vault. Update the agent stack and try again.';
    }
    return scrub(err.message, secrets) || 'Hermes refused the request.';
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/connect|ticket|ECONNREFUSED|socket/i.test(message)) {
    return 'Couldn’t reach Hermes. Start the agent stack and try again.';
  }
  return scrub(message, secrets) || 'Something went wrong talking to Hermes.';
}

function profileParams(agentSlug: unknown): Record<string, unknown> {
  if (typeof agentSlug !== 'string' || !AGENT_SLUG.test(agentSlug)) {
    throw new VaultInputError('Choose an agent');
  }
  const profile = resolveProfileForAgent(agentSlug);
  return profile ? { profile } : {};
}

function call(method: HermesVaultMethod, params: Record<string, unknown>): Promise<unknown> {
  return getHermesGatewaySession().requestVault(method, params);
}

function text(value: unknown, what: string): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new VaultInputError(`Enter ${what}`);
  if (v.length > MAX_TEXT_LENGTH) throw new VaultInputError(`That ${what} is too long`);
  return v;
}

function secret(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new VaultInputError(`Enter ${what}`);
  if (value.length > MAX_SECRET_LENGTH) throw new VaultInputError(`That ${what} is too long`);
  return value;
}

/** Hermes stores `scheme://host[:port]`; reduce whatever the renderer sent to that. */
export function normalizeLoginOrigin(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VaultInputError('Enter the site’s address, like https://www.linkedin.com');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new VaultInputError('The site’s address must start with https://');
  }
  return url.origin;
}

function identifierType(value: unknown): VaultIdentifierType {
  if ((VAULT_IDENTIFIER_TYPES as readonly unknown[]).includes(value)) {
    return value as VaultIdentifierType;
  }
  throw new VaultInputError('Choose email, username or phone');
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Logins only; payment and address items aren't managed on this screen yet. */
export function toVaultLogins(raw: unknown): VaultLogin[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: VaultLogin[] = [];
  for (const item of items as Array<Record<string, unknown>>) {
    if (!item || item.kind !== 'login') continue;
    const id = str(item.id);
    const origin = str(item.origin);
    if (!id || !origin) continue;
    const idType = item.identifier_type;
    out.push({
      id,
      label: str(item.label) ?? origin,
      origin,
      identifier: str(item.identifier) ?? '',
      identifierType: (VAULT_IDENTIFIER_TYPES as readonly unknown[]).includes(idType)
        ? (idType as VaultIdentifierType)
        : null,
      createdAt: str(item.created_at),
      backend: str(item.backend) ?? 'local',
    });
  }
  return out;
}

export function toVaultSources(raw: unknown): VaultSourceStatus[] {
  const sources = (raw as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(sources)) return [];
  return (sources as Array<Record<string, unknown>>)
    .filter((s) => s && str(s.name))
    .map((s) => ({
      name: String(s.name),
      displayName: str(s.display_name) ?? String(s.name),
      enabled: Boolean(s.enabled),
      needsUnlock: Boolean(s.needs_unlock),
      unlocked: Boolean(s.unlocked),
      installed: Boolean(s.installed),
    }));
}

export async function listVaultLogins(payload: { agentSlug: string }): Promise<VaultListResult> {
  try {
    const raw = await call('vault.list', profileParams(payload?.agentSlug));
    return { success: true, logins: toVaultLogins(raw) };
  } catch (err) {
    return { success: false, logins: [], error: errorText(err) };
  }
}

export async function listVaultSources(payload: {
  agentSlug: string;
}): Promise<VaultSourcesResult> {
  try {
    const raw = await call('vault.sources', profileParams(payload?.agentSlug));
    return { success: true, sources: toVaultSources(raw) };
  } catch (err) {
    return { success: false, sources: [], error: errorText(err) };
  }
}

async function addLogin(
  scope: Record<string, unknown>,
  login: {
    label: string;
    origin: string;
    identifierType: VaultIdentifierType;
    identifier: string;
    password: string;
  }
): Promise<string> {
  const result = (await call('vault.add', {
    ...scope,
    kind: 'login',
    label: login.label,
    origin: login.origin,
    secret: {
      identifier_type: login.identifierType,
      identifier: login.identifier,
      password: login.password,
    },
  })) as { id?: unknown } | null;
  const id = str(result?.id);
  if (!id) throw new Error('Hermes didn’t return the saved login');
  return id;
}

export async function addVaultLogin(payload: VaultAddLoginPayload): Promise<VaultActionResult> {
  const password = typeof payload?.password === 'string' ? payload.password : '';
  try {
    const scope = profileParams(payload?.agentSlug);
    const id = await addLogin(scope, {
      label: text(payload.label, 'a name'),
      origin: normalizeLoginOrigin(payload.origin),
      identifierType: identifierType(payload.identifierType),
      identifier: text(payload.identifier, 'a username or email'),
      password: secret(payload.password, 'a password'),
    });
    return { success: true, id };
  } catch (err) {
    return { success: false, error: errorText(err, [password]) };
  }
}

/**
 * Hermes has no update call. Save the new login first and remove the old one only after
 * that works, so a failure never loses the login.
 */
export async function replaceVaultLoginPassword(
  payload: VaultReplacePasswordPayload
): Promise<VaultActionResult> {
  const password = typeof payload?.password === 'string' ? payload.password : '';
  try {
    const scope = profileParams(payload?.agentSlug);
    const id = text(payload.id, 'a login');
    const newPassword = secret(payload.password, 'a password');
    const current = toVaultLogins(await call('vault.list', scope)).find(
      (l) => l.id === id && l.backend === 'local'
    );
    if (!current) throw new VaultInputError('That login is gone. Refresh and try again.');
    const newId = await addLogin(scope, {
      label: current.label,
      origin: current.origin,
      identifierType: current.identifierType ?? 'username',
      identifier: current.identifier,
      password: newPassword,
    });
    try {
      await call('vault.remove', { ...scope, id });
    } catch {
      return {
        success: true,
        id: newId,
        error:
          'Saved the new password, but couldn’t remove the old login. Remove it from the list.',
      };
    }
    return { success: true, id: newId };
  } catch (err) {
    return { success: false, error: errorText(err, [password]) };
  }
}

export async function removeVaultLogin(payload: VaultRemovePayload): Promise<VaultActionResult> {
  try {
    const result = (await call('vault.remove', {
      ...profileParams(payload?.agentSlug),
      id: text(payload?.id, 'a login'),
    })) as { removed?: unknown } | null;
    return result?.removed
      ? { success: true }
      : { success: false, error: 'That login was already removed.' };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}

export async function unlockVaultSource(payload: VaultUnlockPayload): Promise<VaultActionResult> {
  const password = typeof payload?.password === 'string' ? payload.password : '';
  try {
    await call('vault.unlock', {
      ...profileParams(payload?.agentSlug),
      name: text(payload?.name, 'a password manager'),
      password: secret(payload?.password, 'the master password'),
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: errorText(err, [password]) };
  }
}

export async function lockVaultSource(payload: VaultLockPayload): Promise<VaultActionResult> {
  try {
    await call('vault.lock', {
      ...profileParams(payload?.agentSlug),
      name: text(payload?.name, 'a password manager'),
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}
