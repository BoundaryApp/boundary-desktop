import { APP_NAME } from '../../../shared/buildIdentity';
/**
 * The host tools Boundary offers Hermes. Boundary defines this list; it is never taken from the
 * container, and it doesn't change while a session is connected (ADR 0027 §7). The one exception
 * is `offer_setup`, listed only while no calendar is connected: the bridge has no stream to send
 * `tools/list_changed` on, so Boundary changes the listing just before the `reload.mcp` that a
 * calendar connect or removal already makes, and Hermes lists the tools again as it reconnects.
 */

export interface HostToolDefinition<Name extends string = string> {
  name: Name;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

export const NOTIFY_TITLE_MAX = 120;
export const NOTIFY_BODY_MAX = 1000;
export const URL_MAX = 2048;
export const CLIPBOARD_MAX = 100_000;
export const PURPOSE_MAX = 200;
export const PICK_MAX_FILES = 20;
export const READ_FILE_MAX_BYTES = 1024 * 1024;
export const WRITE_FILE_MAX_CHARS = 5 * 1024 * 1024;
/** How long a file chosen with pick_files stays readable. */
export const PICKED_FILE_GRANT_MS = 24 * 60 * 60 * 1000;

const OFFER_SETUP_TOOL = 'offer_setup';
/** What `offer_setup` can offer. Only calendars so far. */
export const SETUP_KINDS = ['calendar'] as const;

const ASKS = `The user approves it in ${APP_NAME}; if they decline, do not retry.`;

/** Keeps each tool's name as a literal, so `HostToolName` lists exactly the catalog. */
function defineHostTools<const Name extends string>(tools: readonly HostToolDefinition<Name>[]) {
  return tools;
}

export const HOST_TOOLS = defineHostTools([
  {
    // Named for where it lands: "notify" alone lost to Hermes's own send_message tool, which
    // delivered a "send me a notification" request to Signal instead.
    name: 'desktop_notification',
    title: 'Show a desktop notification',
    description:
      `Show a pop-up notification on the screen of the computer running ${APP_NAME}. This does ` +
      'not send a message to Signal, Telegram, email or any chat platform; use it only when the ' +
      'user asks for an alert or notification on this computer. The user approves it in ' +
      `${APP_NAME}; if they decline, do not retry.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          maxLength: NOTIFY_TITLE_MAX,
          description: `Short headline. Defaults to "${APP_NAME}".`,
        },
        body: { type: 'string', maxLength: NOTIFY_BODY_MAX, description: 'Detail line.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'open_url',
    title: 'Open a page in the user’s browser',
    description:
      "Open a web page in the user's own default browser on their computer, where they are signed " +
      'in as themselves. Use it to show the user something. To read or act on a page yourself, use ' +
      `your browser tools instead. Only http and https links. ${ASKS}`,
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', maxLength: URL_MAX, description: 'An http or https URL.' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'clipboard_write',
    title: 'Copy text to the clipboard',
    description: `Put text on the clipboard of the user's computer, replacing what is there. ${ASKS}`,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: CLIPBOARD_MAX } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'clipboard_read',
    title: 'Read the clipboard',
    description:
      "Read the text on the user's clipboard. Use it only when the user asks you to use what they " +
      `copied. The user approves every read. ${ASKS}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pick_files',
    title: 'Ask the user to choose files',
    description:
      "Show a file picker on the user's computer so they can choose files for you to read with " +
      'read_file. Say in `purpose` what you need them for; the user sees it. Returns the chosen ' +
      "paths, or nothing if they cancel. Files on the user's computer are not otherwise reachable.",
    inputSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', maxLength: PURPOSE_MAX, description: 'Shown to the user in the picker.' },
        multiple: { type: 'boolean', description: `Allow up to ${PICK_MAX_FILES} files. Default false.` },
        extensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file extensions to offer, without dots, e.g. ["csv", "txt"].',
        },
      },
      required: ['purpose'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    title: 'Read a chosen file',
    description:
      'Read a text file the user chose with pick_files in the last 24 hours. Up to 1 MB of UTF-8 ' +
      'text. Any other path is refused; ask the user to pick it instead.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'A path returned by pick_files.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    title: 'Save a file',
    description:
      "Save text to a file on the user's computer. The user chooses where in a Save dialog every " +
      'time, starting from `suggested_name`. Returns the path, or nothing if they cancel.',
    inputSchema: {
      type: 'object',
      properties: {
        suggested_name: { type: 'string', description: 'File name to start the Save dialog with, e.g. "notes.md".' },
        content: { type: 'string', maxLength: WRITE_FILE_MAX_CHARS },
      },
      required: ['suggested_name', 'content'],
      additionalProperties: false,
    },
  },
  {
    // Decision 7 of docs/calendar-ux-study/spec.md: the model decides when someone is asking about
    // their own schedule, so a question about calendars in general doesn't get the card.
    name: OFFER_SETUP_TOOL,
    title: 'Offer to connect a calendar',
    description:
      "Show the user a Connect a calendar card in this chat. No calendar is connected, so you can't " +
      'see their events. Call it when the user asks about their own schedule, events, meetings or ' +
      'availability, or asks you to add or change an event, then tell them in one sentence that you ' +
      "can't see a calendar yet. Do not call it for general questions about calendars, dates or " +
      'time zones. The card asks nothing of the user until they choose to connect.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...SETUP_KINDS], description: 'What to set up. Only "calendar".' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
]);

/** The one list of tool names: main's dispatch (`hostTools.ts`) is keyed by it. */
export type HostToolName = (typeof HOST_TOOLS)[number]['name'];

export function isHostToolName(name: string): name is HostToolName {
  return HOST_TOOLS.some((tool) => tool.name === name);
}

/** The tools `tools/list` returns now. */
export function listedHostTools(state: { offerCalendarSetup: boolean }): HostToolDefinition[] {
  return HOST_TOOLS.filter((tool) => tool.name !== OFFER_SETUP_TOOL || state.offerCalendarSetup);
}
