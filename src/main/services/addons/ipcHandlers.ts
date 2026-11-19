import { clipboard, shell } from 'electron';
import type {
  AddonId,
  AddonListing,
  TwentyAccess,
  TwentyConnectInput,
} from '../../../shared/types/addons';
import { handle, handleResult } from '../../ipc';
import { persistDebugLog } from '../../persistDebugLog';
import { broadcast } from '../windows';
import { getAssistantStackAccess, reloadHermesForAddons } from '../assistant/AssistantStackService';
import { tryResolveAssistantRoot } from '../assistant/resolveAssistantRoot';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { runningWork } from '../runningWork';
import { availableAddons } from './addonCatalog';
import { installedAddonsAt } from './addonComposeState';
import { checkAddonFit } from './addonFitCheck';
import { getAddonInstaller, runExclusive } from './addonInstaller';
import { applyPendingChanges, onPendingChanges, pendingChanges } from './pendingRestart';
import { copyOwnerPassword, twentyLoginLink, twentyPort } from './twentySignIn';
import { getTwentyService } from './twentyService';
import { ADDON_SLUG } from '../../../shared/utils/slug';
import { actualConnectInput, actualServerInput } from './actualAddon';
import { actualOpenTarget, copyActualServerPassword, getActualService } from './actualRuntime';
import { bitwardenConnectInput } from './bitwardenAddon';
import { getBitwardenService, registerBitwardenStackHooks } from './bitwardenRuntime';
import { isEmailSlug } from '../../../shared/emailAccount';
import { emailAccountInput, emailSettingsInput } from './emailAddon';
import { getEmailService } from './emailRuntime';
import { resolveAssistantUserContentRoot } from '../assistant/assistantPaths';
import { vikunjaDataLeft } from './vikunjaAddon';
import { getVikunjaService } from './vikunjaRuntime';
import { n8nDataLeft } from './builtinAddons';
import { cliOnStack } from './stackScripts';
import { BOUNDARY_ASSISTANT_PROJECT_NAME } from '../../../shared/assistantStackConstants';

/**
 * Logs each listing with metadata only (root, mode, ids, timing), so a missing Add-ons section
 * can be traced to an unresolved root, an empty catalog, a failure, or no call at all.
 */
async function listAddons(): Promise<AddonListing[]> {
  const startedAt = Date.now();
  const { root, error: rootError } = tryResolveAssistantRoot();
  const localStack = isLocalAssistantStackMode();
  const log = (message: string, data: Record<string, unknown>) =>
    persistDebugLog('addons', message, { root, localStack, ms: Date.now() - startedAt, ...data });
  if (!root) {
    log('list: no stack root', { error: rootError ?? null });
    return [];
  }
  try {
    const listings = await readListings(root, localStack);
    log('list', {
      ids: listings.map((l) => l.entry.id),
      installed: listings.filter((l) => l.installed).map((l) => l.entry.id),
    });
    return listings;
  } catch (error) {
    log('list failed', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function inspectVolume(volume: string): Promise<void> {
  await cliOnStack(['volume', 'inspect', volume], { timeoutMs: 15_000 });
}

async function readListings(root: string, localStack: boolean): Promise<AddonListing[]> {
  // Actual and Bitwarden record themselves in the stack's .env, not Boundary's store.
  const installed = installedAddonsAt(root);
  // The installer refuses removal in local stack mode, so the page offers it only outside it.
  const canRemoveData = !localStack;
  return Promise.all(
    availableAddons(root).map(async (entry) => {
      // The installer's check uses the same function, so Try again sees the same fit.
      const { fit, facts, leftover, stopped } = await checkAddonFit(entry);
      const dataLeft =
        entry.id === 'vikunja'
          ? { dataLeft: vikunjaDataLeft(root, resolveAssistantUserContentRoot(root)) }
          : // A local stack's volume belongs to its own project; there is no Remove there anyway.
            entry.id === 'n8n' && !localStack && !installed.includes('n8n')
            ? { dataLeft: await n8nDataLeft(inspectVolume, BOUNDARY_ASSISTANT_PROJECT_NAME) }
            : {};
      return { entry, installed: installed.includes(entry.id), canRemoveData, leftover, stopped, ...dataLeft, fit, facts };
    })
  );
}

/** Rejects an id the active stack has no add-on for, before the installer sees it. */
function knownId(id: unknown): AddonId {
  const { root } = tryResolveAssistantRoot();
  if (root && availableAddons(root).some((entry) => entry.id === id)) return id as AddonId;
  throw new Error(`This stack has no add-on called ${String(id)}.`);
}

const OPEN_FAILED = 'Couldn’t open Twenty.';
const NO_OWNER_LOGIN = 'This stack has no saved Twenty owner login.';

/**
 * Opens Twenty in the system browser, signed in when it can. The link carries a login token, so
 * this opens it with `shell` directly rather than through `openHttpUrlExternally`, which logs
 * and returns Electron's error text, and that text can include the URL. The renderer gets a fixed
 * message on failure and the link never leaves main.
 */
async function openTwenty(): Promise<{ success: boolean; error?: string; warning?: string }> {
  const { root } = getAssistantStackAccess();
  const { url, signedIn, warning, reason } = await twentyLoginLink({ root, port: twentyPort(root) });
  // Metadata only: never the link, its token or the password.
  const log = (opened: boolean) =>
    persistDebugLog('addons', 'twenty open', { signedIn, warning: reason ?? null, opened });
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      log(false);
      return { success: false, error: OPEN_FAILED };
    }
    await shell.openExternal(url);
  } catch {
    log(false);
    return { success: false, error: OPEN_FAILED };
  }
  log(true);
  return warning ? { success: true, warning } : { success: true };
}

function removeOptions(opts: unknown): { deleteImages: boolean } {
  const deleteImages = (opts as { deleteImages?: unknown } | null)?.deleteImages;
  if (typeof deleteImages !== 'boolean') throw new Error('Say whether to delete the images.');
  return { deleteImages };
}

const SLUG = /^[a-z0-9-]+$/;

function knownSlug(slug: unknown): string {
  if (typeof slug === 'string' && SLUG.test(slug)) return slug;
  throw new Error(`crm-${String(slug)} is not a workspace name.`);
}

function knownAccess(access: unknown): TwentyAccess {
  if (access === 'read' || access === 'write') return access;
  throw new Error('Access must be read or write.');
}

/** Checks the renderer's connect input field by field; crm.sh checks the URL itself. */
function connectInput(input: unknown): TwentyConnectInput {
  const i = (input ?? {}) as Record<string, unknown>;
  const ok =
    typeof i.slug === 'string' &&
    SLUG.test(i.slug) &&
    typeof i.url === 'string' &&
    typeof i.keyRw === 'string' &&
    typeof i.keyRo === 'string' &&
    (i.access === 'read' || i.access === 'write') &&
    typeof i.replace === 'boolean';
  if (!ok) throw new Error('The workspace details are incomplete.');
  if (i.slug === 'main') throw new Error('crm-main is this Mac’s Twenty. Pick another name.');
  const { slug, url, keyRw, keyRo, access, replace } = i as unknown as TwentyConnectInput;
  return { slug, url, keyRw, keyRo, access, replace };
}

function actualSlug(slug: unknown): string {
  if (typeof slug === 'string' && ADDON_SLUG.test(slug)) return slug;
  throw new Error(`budget-${String(slug)} is not a budget name.`);
}

/** A connected account's name. Older terminal accounts may break the new-slug rule, so this checks only the shape. */
function bitwardenSlug(slug: unknown): string {
  if (typeof slug === 'string' && /^[a-z0-9-]+$/.test(slug)) return slug;
  throw new Error(`${String(slug)} is not a Bitwarden account name.`);
}

const EMAIL_SLUG_MESSAGE = 'Use lowercase letters, numbers and dashes for the name.';

function emailSlug(slug: unknown): string {
  if (isEmailSlug(slug)) return slug;
  throw new Error(EMAIL_SLUG_MESSAGE);
}

function emailMailboxes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Pick at least one mailbox.');
  if (!value.every((name) => typeof name === 'string' && name !== '')) throw new Error('A mailbox name is empty.');
  return value as string[];
}

const NO_SERVER_PASSWORD = 'This stack has no stored password for this Mac’s Actual server.';
const ACTUAL_OPEN_FAILED = 'Couldn’t open Actual.';

export function registerAddonHandlers(): void {
  registerBitwardenStackHooks();
  const installer = getAddonInstaller();
  installer.onChange((snapshot) => broadcast('addons:progress', snapshot));

  onPendingChanges((list) => broadcast('addons:pending-changed', list));

  handle('addons:list', () => listAddons());
  handle('addons:running-work', () => runningWork());
  handle('addons:snapshot', () => installer.snapshot());
  handle('addons:pending', () => pendingChanges());
  handleResult('addons:apply-pending', async () => {
    await runExclusive(() => applyPendingChanges(reloadHermesForAddons));
    return { success: true };
  });
  handle('addons:twenty-workspaces', () => getTwentyService().listWorkspaces());
  handleResult('addons:twenty-connect', async (_event, input) => {
    const result = await getTwentyService().connect(connectInput(input));
    return { success: true, result };
  });
  handleResult('addons:twenty-disconnect', async (_event, slug) => {
    await getTwentyService().disconnect(knownSlug(slug));
    return { success: true };
  });
  handleResult('addons:twenty-access', async (_event, slug, access) => {
    await getTwentyService().setAccess(knownSlug(slug), knownAccess(access));
    return { success: true };
  });
  handleResult('addons:twenty-open', () => openTwenty());
  handleResult('addons:twenty-copy-password', async () => {
    const { root } = getAssistantStackAccess();
    if (!copyOwnerPassword({ root, clipboard })) throw new Error(NO_OWNER_LOGIN);
    return { success: true };
  });
  handle('addons:actual-overview', () => getActualService().overview());
  handle('addons:actual-refresh', () => getActualService().refreshStatus());
  handleResult('addons:actual-server-budgets', async (_event, input) => {
    const result = await getActualService().serverBudgets(actualServerInput(input));
    return { success: true, result };
  });
  handleResult('addons:actual-connect', async (_event, input) => {
    const result = await getActualService().connect(actualConnectInput(input));
    return { success: true, result };
  });
  handleResult('addons:actual-disconnect', async (_event, slug) => {
    const result = await getActualService().disconnect(actualSlug(slug));
    return { success: true, result };
  });
  handleResult('addons:actual-access', async (_event, slug, access) => {
    const result = await getActualService().setAccess(actualSlug(slug), knownAccess(access));
    return { success: true, result };
  });
  handleResult('addons:actual-open', async (_event, slug) => {
    const url = actualOpenTarget(slug === null ? null : actualSlug(slug));
    if (!url) return { success: false, error: ACTUAL_OPEN_FAILED };
    try {
      await shell.openExternal(url);
    } catch {
      return { success: false, error: ACTUAL_OPEN_FAILED };
    }
    return { success: true };
  });
  handleResult('addons:vikunja-open', async () => {
    const target = await getVikunjaService().webUrl();
    if ('error' in target) return { success: false, error: target.error };
    try {
      await shell.openExternal(target.url);
    } catch {
      return { success: false, error: 'Couldn’t open Todo lists in the browser.' };
    }
    return { success: true };
  });
  handleResult('addons:actual-copy-password', () => {
    if (!copyActualServerPassword(clipboard)) throw new Error(NO_SERVER_PASSWORD);
    return { success: true };
  });
  getBitwardenService().onChange((overview) => broadcast('addons:bitwarden-changed', overview));
  handle('addons:bitwarden-overview', () => getBitwardenService().overview());
  handle('addons:bitwarden-refresh', () => getBitwardenService().refresh());
  handleResult('addons:bitwarden-connect', async (_event, input) => {
    const result = await getBitwardenService().connect(bitwardenConnectInput(input));
    return { success: true, result };
  });
  handleResult('addons:bitwarden-disconnect', async (_event, slug) => {
    const name = bitwardenSlug(slug);
    if (name === 'local') throw new Error('The stack’s own account is managed at the terminal.');
    const result = await getBitwardenService().disconnect(name);
    return { success: true, result };
  });
  handleResult('addons:bitwarden-unlock', async (_event, slug, masterPassword) => {
    if (typeof masterPassword !== 'string' || masterPassword === '') throw new Error('Enter the master password.');
    const result = await getBitwardenService().unlock(bitwardenSlug(slug), masterPassword);
    return { success: true, result };
  });
  handleResult('addons:bitwarden-lock', async (_event, slug) => {
    const result = await getBitwardenService().lock(bitwardenSlug(slug));
    return { success: true, result };
  });
  handleResult('addons:bitwarden-sync', async () => {
    const result = await getBitwardenService().sync();
    return { success: true, result };
  });
  getEmailService().onChange((overview) => broadcast('addons:email-changed', overview));
  handle('addons:email-overview', () => getEmailService().overview());
  handle('addons:email-refresh', () => getEmailService().refresh());
  handleResult('addons:email-save-account', async (_event, input) => {
    const result = await getEmailService().saveAccount(emailAccountInput(input));
    return { success: true, result };
  });
  handleResult('addons:email-mailboxes', async (_event, slug) => {
    const result = await getEmailService().listMailboxes(emailSlug(slug));
    return { success: true, result };
  });
  handleResult('addons:email-set-mailboxes', async (_event, slug, mailboxes) => {
    const result = await getEmailService().setMailboxes(emailSlug(slug), emailMailboxes(mailboxes));
    return { success: true, result };
  });
  handleResult('addons:email-cancel-account', async (_event, slug) => {
    await getEmailService().removeNewAccount(emailSlug(slug));
    return { success: true };
  });
  handleResult('addons:email-remove-account', async (_event, slug) => {
    const result = await getEmailService().removeAccount(emailSlug(slug));
    return { success: true, result };
  });
  handleResult('addons:email-settings', async (_event, input) => {
    const result = await getEmailService().setSettings(emailSettingsInput(input));
    return { success: true, result };
  });
  handleResult('addons:install', async (_event, id, options) => {
    const { access, remote, email, makeRoom } = (options ?? {}) as {
      access?: unknown;
      remote?: unknown;
      email?: unknown;
      makeRoom?: unknown;
    };
    const addon = knownId(id);
    // Only a literal true asks the installer to restart the engine larger (ADR 0055 §3).
    const room = makeRoom === true ? { makeRoom: true } : {};
    if (email !== undefined) {
      if (addon !== 'email') throw new Error('Only email takes an account as it installs.');
      const account = emailSlug((email as { account?: unknown } | null)?.account);
      await installer.install(addon, { email: { account } });
    } else if (remote !== undefined) {
      if (addon !== 'actual') throw new Error('Only Actual connects a budget as it installs.');
      await installer.install(addon, { remote: actualConnectInput(remote) });
    } else if (access === undefined) {
      if (makeRoom === true) await installer.install(addon, room);
      else await installer.install(addon);
    } else await installer.install(addon, { access: knownAccess(access), ...room });
    return { success: true };
  });
  handleResult('addons:cancel', (_event, id) => {
    installer.cancel(knownId(id));
    return { success: true };
  });
  handleResult('addons:undo', async (_event, id) => {
    await installer.undo(knownId(id));
    return { success: true };
  });
  handleResult('addons:restart', async (_event, id) => {
    await installer.restart(knownId(id));
    return { success: true };
  });
  handleResult('addons:start', async (_event, id) => {
    await installer.start(knownId(id));
    return { success: true };
  });
  handleResult('addons:turn-off', async (_event, id) => {
    await installer.turnOff(knownId(id));
    return { success: true };
  });
  handleResult('addons:remove', async (_event, id, opts) => {
    await installer.remove(knownId(id), removeOptions(opts));
    return { success: true };
  });
}
