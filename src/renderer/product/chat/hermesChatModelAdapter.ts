import type { ChatModelAdapter } from '@assistant-ui/react';
import { hermesChatIPC } from '../../services/hermesChatIPCService';
import type { ServerEntry, ServerPath } from './serverPath';
import { writtenPathsOf } from '../../../shared/hermesToolPaths';
import { filedTaskOf } from '../../../shared/hermesKanbanFiled';
import type { KanbanFiledTask } from '../../../shared/types/hermesKanban';
import type { HermesNoReply } from '../../../shared/types/hermesChat';
import { ownRunningTurn, releaseRunningTurn } from './runningTurns';
import { appendSpeakerChunk, joinSpeakerSegments, type SpeakerSegment } from './speakerSegments';

export const DIVERGED_MESSAGE =
  'This is an earlier version, and Hermes only keeps the latest one. Switch back with ‹ › to continue.';

export const CONTINUE_LATEST_ONLY_MESSAGE = 'Only the latest reply can be continued.';

/**
 * Run config for Continue on a stopped reply (run-control spec 1.7): start a run whose
 * parent is that reply, and the adapter asks Hermes to pick up from its saved partial.
 */
export const CONTINUE_RUN_CONFIG = { custom: { continue: true } } as const;

/**
 * assistant-ui aborts with `detach: true` when the runtime unmounts, and `detach: false`
 * for cancelRun (Stop).
 */
function isDetachAbort(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as { detach?: unknown }).detach === true
  );
}

function toServerEntry(message: {
  id: string;
  role: string;
  content: unknown;
  metadata?: { custom?: Record<string, unknown> };
}): ServerEntry {
  const rowId = message.metadata?.custom?.rowId;
  return {
    id: message.id,
    role: message.role,
    text: messageText(message.content),
    rowId: typeof rowId === 'number' ? rowId : null,
  };
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'type' in part && part.type === 'text') {
        return String((part as { text?: string }).text ?? '');
      }
      return '';
    })
    .join('');
}

/**
 * Maps Hermes chat IPC deltas into LocalRuntime cumulative text yields.
 * Credentials and tickets never enter the renderer.
 */
export function createHermesChatModelAdapter(
  getSessionId: () => string | null,
  opts?: {
    onSessionResolved?: (sessionId: string) => void;
    getToolsEnabled?: () => boolean;
    getAgentSlug?: () => string | null;
    onLocalUnreachable?: () => void;
    onApplyFailed?: (error: string) => void;
    /**
     * What Hermes holds for the mounted runtime; decides whether a run appends or
     * replaces (Edit / Retry). A getter, because each runtime mount has its own.
     */
    getServerPath?: () => ServerPath | null;
  }
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal, unstable_assistantMessageId, runConfig }) {
      const serverPath = opts?.getServerPath?.() ?? null;
      const path = messages.map(toServerEntry);
      const plan = serverPath?.plan(path) ?? { kind: 'append' as const };
      const continuing = runConfig?.custom?.continue === true;
      if (continuing && plan.kind !== 'continue') {
        throw new Error(CONTINUE_LATEST_ONLY_MESSAGE);
      }
      if (plan.kind === 'diverged' || (plan.kind === 'continue' && !continuing)) {
        throw new Error(DIVERGED_MESSAGE);
      }

      const mapped = messages
        .map((message) => {
          const role =
            message.role === 'system' || message.role === 'assistant' || message.role === 'user'
              ? message.role
              : 'user';
          return {
            role,
            content: messageText(message.content),
          };
        })
        .filter((message) => message.content.trim().length > 0);

      // However the run ends, the runtime now shows this turn and its reply, so the
      // server path follows it. If Hermes never received the turn, main treats a later
      // Retry of it as a plain send, so a failed send never strands the chat.
      const settle = (replyText: string) => {
        serverPath?.commit(path);
        if (unstable_assistantMessageId) {
          serverPath?.append({
            id: unstable_assistantMessageId,
            role: 'assistant',
            text: replyText,
            rowId: null,
          });
        }
      };

      let start: Awaited<ReturnType<typeof hermesChatIPC.startChat>>;
      try {
        start = await hermesChatIPC.startChat({
          sessionId: getSessionId() ?? undefined,
          messages: mapped,
          toolsEnabled: opts?.getToolsEnabled?.() ?? true,
          agentSlug: opts?.getAgentSlug?.() ?? undefined,
          ...(plan.kind === 'rewind' ? { rewind: plan.request } : {}),
          ...(plan.kind === 'continue' ? { continue: true } : {}),
        });
      } catch (err) {
        settle('');
        throw err;
      }

      if (!start.success) {
        settle('');
        if (start.errorCode === 'rewind-unsupported') serverPath?.setRewindable(false);
        if (start.errorCode === 'local-unreachable') {
          opts?.onLocalUnreachable?.();
          return;
        }
        if (start.errorCode === 'apply-failed') {
          opts?.onApplyFailed?.(start.error ?? 'Could not apply the inference connection.');
          return;
        }
        throw new Error(start.error ?? 'Failed to start chat');
      }

      if (start.sessionId) {
        opts?.onSessionResolved?.(start.sessionId);
      }

      if (start.transport === 'http') serverPath?.setRewindable(false);

      if (start.posted) {
        settle('');
        return;
      }

      const { requestId } = start;
      let text = '';
      // A room wake streams several agents; each gets its own section (ADR 0010 §1).
      const segments: SpeakerSegment[] = [];
      const speakers = () => {
        const first = segments[0]?.agentSlug;
        return {
          ...(first ? { agentSlug: first } : {}),
          ...(segments.length > 1 ? { segments: segments.map((s) => ({ ...s })) } : {}),
        };
      };
      // Files this turn's write tools touched (the Files line under the reply), and how
      // many tools ran ("No tools used"). HTTP-fallback turns send no tool events, so
      // their count stays unknown.
      const files: string[] = [];
      const toolsRun = new Set<string>();
      // Kanban tasks the turn filed: task cards under the reply.
      const tasksFiled: KanbanFiledTask[] = [];
      const turnMeta = () => ({
        metadata: {
          custom: {
            ...speakers(),
            ...(files.length > 0 ? { files: [...files] } : {}),
            ...(tasksFiled.length > 0 ? { tasksFiled: [...tasksFiled] } : {}),
            ...(start.transport === 'json-rpc' ? { toolCount: toolsRun.size } : {}),
          },
        },
      });
      let finished = false;
      let error: string | null = null;
      let noReply: HermesNoReply | null = null;
      // This screen shows the turn; a list of running turns must not reload it on end.
      ownRunningTurn(requestId);

      const waiters: Array<() => void> = [];
      const wake = () => {
        while (waiters.length > 0) {
          waiters.shift()?.();
        }
      };

      const unsubs = [
        hermesChatIPC.onChatTool((event) => {
          if (event.requestId !== requestId || event.status !== 'done') return;
          toolsRun.add(event.toolId);
          for (const path of writtenPathsOf(event.name, event.args ?? null)) {
            if (!files.includes(path)) files.push(path);
          }
          const filed = filedTaskOf(event.name, event.args ?? null, event.summary ?? null);
          if (filed) tasksFiled.push(filed);
        }),
        hermesChatIPC.onChatChunk((event) => {
          if (event.requestId !== requestId) return;
          appendSpeakerChunk(segments, event.delta, event.agentSlug);
          text = segments.length > 1 ? joinSpeakerSegments(segments) : segments[0].text;
          wake();
        }),
        hermesChatIPC.onChatEnd((event) => {
          if (event.requestId !== requestId) return;
          noReply = event.noReply ?? null;
          finished = true;
          wake();
        }),
        hermesChatIPC.onChatError((event) => {
          if (event.requestId !== requestId) return;
          error = event.error;
          finished = true;
          wake();
        }),
      ];

      const onAbort = () => {
        // Unmounting the runtime (leaving the chat or switching chats) detaches it. The
        // turn keeps running in Hermes and its reply loads with the history; only Stop
        // cancels it.
        if (isDetachAbort(abortSignal.reason)) {
          // Whichever screen shows this chat next reloads it when the turn ends.
          releaseRunningTurn(requestId);
        } else {
          void hermesChatIPC.cancelChat({ requestId, reason: 'stopped' });
        }
        finished = true;
        wake();
      };
      abortSignal.addEventListener('abort', onAbort);
      // Stop (or unmount) can land while startChat is still in flight; the abort event
      // has then already fired, so handle it now or Hermes keeps generating.
      if (abortSignal.aborted) onAbort();

      try {
        while (!finished) {
          if (text.length > 0) {
            yield {
              content: [{ type: 'text' as const, text }],
              metadata: { custom: speakers() },
            };
          }
          await new Promise<void>((resolve) => {
            if (finished) {
              resolve();
              return;
            }
            waiters.push(resolve);
          });
        }

        if (error) {
          throw new Error(error);
        }

        if (abortSignal.aborted) {
          return;
        }

        const meta = turnMeta();
        yield {
          content: [{ type: 'text' as const, text }],
          ...(noReply && !text.trim()
            ? { metadata: { custom: { ...meta.metadata.custom, noReply } } }
            : meta),
        };
      } finally {
        abortSignal.removeEventListener('abort', onAbort);
        for (const unsub of unsubs) unsub();
        settle(text);
      }
    },
  };
}
