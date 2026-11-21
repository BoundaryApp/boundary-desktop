import type { WebContents } from 'electron';
import { extractPathsFromToolArgs } from '../../../../shared/hermesToolPaths';
import { sendEvent as send } from '../../../ipc';
import { buildCodingAccessRequest } from '../coding/codingAccessRequests';
import { conversationProjectId } from './hermesChatProjects';

/** Hermes's Bitwarden plugin tool for a login the agent can't reach (stack addons/bitwarden/addon.json). */
const BITWARDEN_REQUEST_TOOL = 'bitwarden_request_access';

/** A `tool.start` or `tool.complete` payload, with the defaults the chat shows for missing fields. */
export interface ToolPayload {
  toolId: string;
  name: string;
  args: Record<string, unknown> | undefined;
  paths: string[];
  summary: string | undefined;
  resultText: string | undefined;
  durationSec: number | undefined;
}

/** Reads a tool event's payload. `toolTurn` names a tool Hermes sent without an id. */
export function toolPayload(raw: unknown, toolTurn: number): ToolPayload {
  const payload = raw as
    | {
        tool_id?: string;
        name?: string;
        args?: Record<string, unknown> | null;
        duration_s?: unknown;
        summary?: string | null;
        result_text?: string | null;
      }
    | undefined;
  const args = payload?.args ?? undefined;
  return {
    toolId: payload?.tool_id ?? `tool-${toolTurn}`,
    name: payload?.name ?? 'tool',
    args,
    paths: extractPathsFromToolArgs(args ?? null),
    summary: payload?.summary ?? undefined,
    resultText: payload?.result_text ?? undefined,
    durationSec: typeof payload?.duration_s === 'number' ? payload.duration_s : undefined,
  };
}

export interface ToolCompleteContext {
  sender: WebContents;
  requestId: string;
  sessionId: string;
  tool: ToolPayload;
}

/** A coding task outside the coding folders: ask the user, don't hint at make (ADR 0028 §9). */
function askForCodingAccess({ sender, requestId, sessionId, tool }: ToolCompleteContext): void {
  const access = buildCodingAccessRequest({
    toolName: tool.name,
    resultText: tool.resultText ?? tool.summary ?? null,
    args: tool.args ?? null,
    sessionId,
    requestId,
    projectId: conversationProjectId(sessionId),
  });
  if (access) send(sender, 'coding-folders:access-request', access);
}

/** The agent asked for a Bitwarden login: show the request on Bitwarden's page (decision 30). */
function noteBitwardenRequest({ tool }: ToolCompleteContext): void {
  if (tool.name !== BITWARDEN_REQUEST_TOOL) return;
  void import('../../addons/bitwardenRuntime')
    .then((m): void => m.noteChatToolCall(tool.name))
    .catch((): void => undefined);
}

/** What Boundary does when a tool of a chat turn completes, beside showing it, in order. */
const TOOL_COMPLETE_REACTIONS: ReadonlyArray<(context: ToolCompleteContext) => void> = [
  askForCodingAccess,
  noteBitwardenRequest,
];

export function onToolComplete(context: ToolCompleteContext): void {
  for (const react of TOOL_COMPLETE_REACTIONS) react(context);
}
