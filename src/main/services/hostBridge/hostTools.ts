import path from 'node:path';
import type { HostBridgeApprovalEvent } from '../../../shared/types/hostBridge';
import type { ApprovalOutcome } from './approvals';
import type { AuditEntry } from './auditLog';
import type { ToolCallResult } from './mcpProtocol';
import {
  CLIPBOARD_MAX,
  NOTIFY_BODY_MAX,
  NOTIFY_TITLE_MAX,
  PICK_MAX_FILES,
  PICKED_FILE_GRANT_MS,
  PURPOSE_MAX,
  READ_FILE_MAX_BYTES,
  URL_MAX,
  WRITE_FILE_MAX_CHARS,
} from './toolCatalog';

/**
 * Runs one host-tool call in main: read the arguments, check for a standing grant, ask the user
 * if there is none, act, and record what happened (ADR 0027 §7). Every path writes one audit
 * entry, and the audit never holds clipboard text or file contents, only sizes and paths.
 * Dependencies are passed in so tests can drive each path.
 */

export interface HostToolDeps {
  hasGrant(capability: string, resource?: string): boolean;
  addGrant(capability: string, resource?: string, expiresAt?: string | null): void;
  requestApproval(
    request: Omit<HostBridgeApprovalEvent, 'id' | 'expiresAt' | 'choices'>
  ): Promise<ApprovalOutcome>;
  /** Resolves `shown` once the OS confirms it, `unconfirmed` if it doesn't say within a few seconds. */
  showNotification(title: string, body: string): Promise<'shown' | 'unconfirmed'>;
  openExternal(url: string): Promise<void>;
  readClipboard(): string;
  writeClipboard(text: string): void;
  /** Native open dialog; resolves the chosen absolute paths, or none when cancelled. */
  pickFiles(options: { message: string; multiple: boolean; extensions: string[] }): Promise<string[]>;
  /** Native save dialog; resolves the chosen absolute path, or null when cancelled. */
  chooseSavePath(options: { defaultName: string }): Promise<string | null>;
  /** Size of a regular file, or null when the path isn't one. */
  fileSize(filePath: string): Promise<number | null>;
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, content: string): Promise<void>;
  now(): number;
  audit(entry: AuditEntry): void;
}

type Tool = AuditEntry['tool'];

function text(message: string, isError = false): ToolCallResult {
  return { content: [{ type: 'text', text: message }], ...(isError ? { isError: true } : {}) };
}

type Parsed<T> = { value: T } | { error: string };

function unexpected(args: Record<string, unknown>, allowed: string[]): string | null {
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  return extra.length ? `Unexpected arguments: ${extra.join(', ')}` : null;
}

function invalid(tool: Tool, args: Record<string, unknown>, error: string, deps: HostToolDeps): ToolCallResult {
  deps.audit({ tool, decision: 'invalid', args, outcome: error });
  return text(`Invalid arguments: ${error}`, true);
}

/**
 * Ask unless a grant covers the call. `always` (when given) is what "Always allow" would cover;
 * leave it out for calls that must ask every time. Returns the audit decision, or the result to
 * hand back when the user declined.
 */
async function approve(
  deps: HostToolDeps,
  call: {
    tool: Tool;
    read: Record<string, unknown>;
    capability: string;
    title: string;
    detail: string;
    always?: { resource: string; description: string };
  }
): Promise<{ decision: AuditEntry['decision'] } | { result: ToolCallResult }> {
  if (call.always && deps.hasGrant(call.capability, call.always.resource)) return { decision: 'granted' };
  const outcome = await deps.requestApproval({
    capability: call.capability,
    title: call.title,
    detail: call.detail,
    alwaysDescription: call.always?.description,
  });
  if (outcome === 'deny' || outcome === 'timeout') {
    deps.audit({ tool: call.tool, decision: outcome === 'deny' ? 'denied' : 'timeout', args: call.read });
    return {
      result: text(
        outcome === 'deny'
          ? 'The user declined this in Boundary. Do not retry it.'
          : 'Nobody answered the approval in Boundary within 2 minutes, so nothing was done.',
        true
      ),
    };
  }
  if (outcome === 'always' && call.always) deps.addGrant(call.capability, call.always.resource);
  return { decision: outcome === 'always' ? 'always' : 'allowed' };
}

async function attempt(
  deps: HostToolDeps,
  tool: Tool,
  read: Record<string, unknown>,
  failure: string,
  run: () => Promise<ToolCallResult>
): Promise<ToolCallResult> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.audit({ tool, decision: 'error', args: read, outcome: message });
    return text(`${failure}: ${message}`, true);
  }
}

// ---------------------------------------------------------------------------- desktop_notification

function parseNotifyArgs(args: Record<string, unknown>): Parsed<{ title: string; body: string }> {
  const extra = unexpected(args, ['title', 'body']);
  if (extra) return { error: extra };
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) return { error: 'title is required' };
  if (title.length > NOTIFY_TITLE_MAX) return { error: `title is over ${NOTIFY_TITLE_MAX} characters` };
  if (args.body !== undefined && typeof args.body !== 'string') return { error: 'body must be a string' };
  const body = typeof args.body === 'string' ? args.body.trim() : '';
  if (body.length > NOTIFY_BODY_MAX) return { error: `body is over ${NOTIFY_BODY_MAX} characters` };
  return { value: { title, body } };
}

async function desktopNotification(args: Record<string, unknown>, deps: HostToolDeps): Promise<ToolCallResult> {
  const tool = 'desktop_notification';
  const parsed = parseNotifyArgs(args);
  if ('error' in parsed) return invalid(tool, args, parsed.error, deps);
  const { title, body } = parsed.value;
  const read = { title, body };

  const gate = await approve(deps, {
    tool,
    read,
    // The grant keeps the tool's original name, so "Always allow" answers given before the rename hold.
    capability: 'notify',
    title: 'Show a desktop notification',
    detail: body ? `${title}\n${body}` : title,
    always: { resource: '*', description: 'From now on, Hermes can show desktop notifications without asking.' },
  });
  if ('result' in gate) return gate.result;

  return attempt(deps, tool, read, 'Boundary could not show the notification', async () => {
    const shown = await deps.showNotification(title, body);
    deps.audit({ tool, decision: gate.decision, args: read, outcome: shown });
    return text(
      shown === 'shown'
        ? 'Notification shown.'
        : "Boundary handed the notification to the system, but the system didn't confirm it appeared. " +
            'Focus or the notification settings for Boundary may be hiding it; it may be in Notification Center.'
    );
  });
}

// ---------------------------------------------------------------------------- open_url

async function openUrl(args: Record<string, unknown>, deps: HostToolDeps): Promise<ToolCallResult> {
  const tool = 'open_url';
  const extra = unexpected(args, ['url']);
  if (extra) return invalid(tool, args, extra, deps);
  const raw = typeof args.url === 'string' ? args.url.trim() : '';
  if (!raw || raw.length > URL_MAX) return invalid(tool, args, `url is required and at most ${URL_MAX} characters`, deps);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid(tool, args, 'url is not a valid URL', deps);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return invalid(tool, args, 'only http and https links can be opened', deps);
  }
  const href = url.toString();
  const host = url.hostname.toLowerCase();
  const read = { url: href };

  const gate = await approve(deps, {
    tool,
    read,
    capability: 'open_url',
    title: 'Open a page in your browser',
    detail: href,
    always: { resource: host, description: `From now on, Hermes can open ${host} pages in your browser without asking.` },
  });
  if ('result' in gate) return gate.result;

  return attempt(deps, tool, read, 'Boundary could not open the page', async () => {
    await deps.openExternal(href);
    deps.audit({ tool, decision: gate.decision, args: read, outcome: 'opened' });
    return text(`Opened ${href} in the user's browser.`);
  });
}

// ---------------------------------------------------------------------------- clipboard

const PREVIEW_CHARS = 500;

async function clipboardWrite(args: Record<string, unknown>, deps: HostToolDeps): Promise<ToolCallResult> {
  const tool = 'clipboard_write';
  const extra = unexpected(args, ['text']);
  // Argument names only: the audit never holds what would go on the clipboard.
  if (extra) return invalid(tool, { arguments: Object.keys(args) }, extra, deps);
  if (typeof args.text !== 'string') return invalid(tool, { chars: null }, 'text must be a string', deps);
  const value = args.text;
  if (value.length > CLIPBOARD_MAX) return invalid(tool, { chars: value.length }, `text is over ${CLIPBOARD_MAX} characters`, deps);
  const read = { chars: value.length };
  const preview = value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…\n(${value.length} characters in all)` : value;

  const gate = await approve(deps, {
    tool,
    read,
    capability: 'clipboard_write',
    title: 'Copy to your clipboard',
    detail: preview || '(empty)',
    always: { resource: '*', description: 'From now on, Hermes can replace your clipboard without asking.' },
  });
  if ('result' in gate) return gate.result;

  return attempt(deps, tool, read, 'Boundary could not set the clipboard', async () => {
    deps.writeClipboard(value);
    deps.audit({ tool, decision: gate.decision, args: read, outcome: 'copied' });
    return text('Copied to the clipboard.');
  });
}

async function clipboardRead(args: Record<string, unknown>, deps: HostToolDeps): Promise<ToolCallResult> {
  const tool = 'clipboard_read';
  const extra = unexpected(args, []);
  if (extra) return invalid(tool, args, extra, deps);
  const read = {};

  // Every read asks: what's on a clipboard changes, and is often a password or a private note.
  const gate = await approve(deps, {
    tool,
    read,
    capability: 'clipboard_read',
    title: 'Read your clipboard',
    detail: 'Hermes will see the text you last copied.',
  });
  if ('result' in gate) return gate.result;

  return attempt(deps, tool, read, 'Boundary could not read the clipboard', async () => {
    const value = deps.readClipboard();
    deps.audit({ tool, decision: gate.decision, args: read, outcome: `${value.length} chars` });
    if (!value) return text('The clipboard has no text.');
    return text(value.length > CLIPBOARD_MAX ? `${value.slice(0, CLIPBOARD_MAX)}\n…(cut at ${CLIPBOARD_MAX} characters)` : value);
  });
}

// ---------------------------------------------------------------------------- files

function parsePickArgs(args: Record<string, unknown>): Parsed<{ purpose: string; multiple: boolean; extensions: string[] }> {
  const extra = unexpected(args, ['purpose', 'multiple', 'extensions']);
  if (extra) return { error: extra };
  const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
  if (!purpose || purpose.length > PURPOSE_MAX) return { error: `purpose is required and at most ${PURPOSE_MAX} characters` };
  if (args.multiple !== undefined && typeof args.multiple !== 'boolean') return { error: 'multiple must be true or false' };
  const rawExtensions = args.extensions ?? [];
  if (!Array.isArray(rawExtensions) || rawExtensions.some((ext) => typeof ext !== 'string')) {
    return { error: 'extensions must be a list of strings' };
  }
  const extensions = (rawExtensions as string[])
    .map((ext) => ext.trim().replace(/^\./, '').toLowerCase())
    .filter((ext) => /^[a-z0-9]{1,10}$/.test(ext));
  return { value: { purpose, multiple: Boolean(args.multiple), extensions } };
}

const PICKED_FILES_NOTE =
  "These paths are on the user's computer, not in your filesystem, so your own file and shell " +
  "tools can't open them. Read each one with Boundary's read_file tool, passing its path exactly.";

async function pickFiles(args: Record<string, unknown>, deps: HostToolDeps): Promise<ToolCallResult> {
  const tool = 'pick_files';
  const parsed = parsePickArgs(args);
  if ('error' in parsed) return invalid(tool, args, parsed.error, deps);
  const { purpose, multiple, extensions } = parsed.value;
  const read = { purpose, multiple, extensions };

  // The picker is the consent: Hermes only ever gets the files the user chooses in it.
  return attempt(deps, tool, read, 'Boundary could not show the file picker', async () => {
    const chosen = (await deps.pickFiles({ message: `Hermes asks: ${purpose}`, multiple, extensions })).slice(0, PICK_MAX_FILES);
    if (!chosen.length) {
      deps.audit({ tool, decision: 'denied', args: read, outcome: 'cancelled' });
      return text("The user didn't choose any files.");
    }
    const expiresAt = new Date(deps.now() + PICKED_FILE_GRANT_MS).toISOString();
    const files = [];
    for (const chosenPath of chosen) {
      const resolved = path.resolve(chosenPath);
      deps.addGrant('read_file', resolved, expiresAt);
      files.push({ path: resolved, name: path.basename(resolved), bytes: await deps.fileSize(resolved) });
    }
    deps.audit({ tool, decision: 'allowed', args: read, outcome: files.map((file) => file.path).join('\n') });
    // Hermes runs in a container, so it tends to open these paths with its own file tools and
    // miss. Say so in the result, where it reads it next, rather than only in the tool catalog.
    return text(JSON.stringify({ how_to_read: PICKED_FILES_NOTE, files, readable_until: expiresAt }, null, 2));
  });
}

async function readFile(args: Record<string, unknown>, deps: HostToolDeps): Promise<ToolCallResult> {
  const tool = 'read_file';
  const extra = unexpected(args, ['path']);
  if (extra) return invalid(tool, args, extra, deps);
  const raw = typeof args.path === 'string' ? args.path : '';
  if (!raw || !path.isAbsolute(raw)) return invalid(tool, args, 'path must be an absolute path from pick_files', deps);
  const filePath = path.resolve(raw);
  const read = { path: filePath };

  if (!deps.hasGrant('read_file', filePath)) {
    deps.audit({ tool, decision: 'denied', args: read, outcome: 'not picked' });
    return text(
      'Boundary only reads files the user chose with pick_files in the last 24 hours. Ask the user to pick this file.',
      true
    );
  }
  return attempt(deps, tool, read, 'Boundary could not read the file', async () => {
    const size = await deps.fileSize(filePath);
    if (size === null) {
      deps.audit({ tool, decision: 'error', args: read, outcome: 'not a file' });
      return text('That path is no longer a file.', true);
    }
    if (size > READ_FILE_MAX_BYTES) {
      deps.audit({ tool, decision: 'error', args: read, outcome: `${size} bytes, over the limit` });
      return text(`The file is ${size} bytes; read_file reads up to ${READ_FILE_MAX_BYTES}.`, true);
    }
    const content = (await deps.readFile(filePath)).toString('utf8');
    if (content.includes('\u0000')) {
      deps.audit({ tool, decision: 'error', args: read, outcome: 'binary' });
      return text('The file is not text; read_file reads UTF-8 text files only.', true);
    }
    deps.audit({ tool, decision: 'granted', args: read, outcome: `${size} bytes` });
    return text(content);
  });
}

async function writeFile(args: Record<string, unknown>, deps: HostToolDeps): Promise<ToolCallResult> {
  const tool = 'write_file';
  const extra = unexpected(args, ['suggested_name', 'content']);
  // Argument names only: the audit never holds file contents.
  if (extra) return invalid(tool, { arguments: Object.keys(args) }, extra, deps);
  const suggested = typeof args.suggested_name === 'string' ? path.basename(args.suggested_name.trim()) : '';
  if (!suggested || suggested === '.' || suggested === '..') return invalid(tool, { suggested_name: args.suggested_name }, 'suggested_name is required', deps);
  if (typeof args.content !== 'string') return invalid(tool, { suggested_name: suggested }, 'content must be a string', deps);
  const content = args.content;
  if (content.length > WRITE_FILE_MAX_CHARS) {
    return invalid(tool, { suggested_name: suggested, chars: content.length }, `content is over ${WRITE_FILE_MAX_CHARS} characters`, deps);
  }
  const read = { suggested_name: suggested, chars: content.length };

  // The Save dialog is the consent, every time: the user picks the place and can cancel.
  return attempt(deps, tool, read, 'Boundary could not save the file', async () => {
    const target = await deps.chooseSavePath({ defaultName: suggested });
    if (!target) {
      deps.audit({ tool, decision: 'denied', args: read, outcome: 'cancelled' });
      return text("The user cancelled the Save dialog, so nothing was saved.");
    }
    await deps.writeFile(target, content);
    deps.audit({ tool, decision: 'allowed', args: read, outcome: target });
    return text(`Saved to ${target}.`);
  });
}

// ---------------------------------------------------------------------------- dispatch

export async function executeHostTool(
  name: string,
  args: Record<string, unknown>,
  deps: HostToolDeps
): Promise<ToolCallResult> {
  switch (name) {
    case 'desktop_notification':
      return desktopNotification(args, deps);
    case 'open_url':
      return openUrl(args, deps);
    case 'clipboard_write':
      return clipboardWrite(args, deps);
    case 'clipboard_read':
      return clipboardRead(args, deps);
    case 'pick_files':
      return pickFiles(args, deps);
    case 'read_file':
      return readFile(args, deps);
    case 'write_file':
      return writeFile(args, deps);
    default:
      deps.audit({ tool: name, decision: 'invalid', args: {}, outcome: 'unknown tool' });
      return text(`Unknown tool: ${name}`, true);
  }
}
