import type { ThreadMessageLike } from '@assistant-ui/react';
import type { HermesChatMessage } from '../../../shared/types/hermesChat';
import type { ServerEntry } from './serverPath';
import type { HermesMessageCustom } from './messageCustom';

/**
 * Hydrated history row → runtime message. `custom.ts` is always set (null when the
 * source had no time) so the transcript never mistakes load time for send time;
 * live turns have no `custom.ts` and use the runtime's own `createdAt`.
 * The id is fixed so the server path can name hydrated messages before the runtime exists.
 */
const historyMessageId = (index: number) => `hist-${index}`;

export function toServerEntries(messages: HermesChatMessage[]): ServerEntry[] {
  return messages.map((m, i) => ({
    id: historyMessageId(i),
    role: m.role,
    text: m.content,
    rowId: m.rowId ?? null,
    ...(m.localOnly ? { localOnly: true } : {}),
  }));
}

export function toThreadMessage(m: HermesChatMessage, index: number): ThreadMessageLike {
  return {
    id: historyMessageId(index),
    role: m.role,
    content: m.content,
    ...(m.timestamp != null ? { createdAt: new Date(m.timestamp * 1000) } : {}),
    metadata: {
      custom: {
        ts: m.timestamp ?? null,
        rowId: m.rowId ?? null,
        ...(m.files && m.files.length > 0 ? { files: m.files } : {}),
        ...(m.tasksFiled && m.tasksFiled.length > 0 ? { tasksFiled: m.tasksFiled } : {}),
        ...(m.toolCount != null ? { toolCount: m.toolCount } : {}),
        ...(m.ending ? { ending: m.ending } : {}),
        ...(m.writingVoiceName ? { writingVoiceName: m.writingVoiceName } : {}),
        ...(m.noReply ? { noReply: m.noReply } : {}),
        ...(m.localOnly ? { localOnly: true } : {}),
        // Who spoke this turn in a room; the reply's speaker line reads it (ADR 0023).
        ...(m.agentSlug ? { agentSlug: m.agentSlug } : {}),
      } satisfies HermesMessageCustom,
    },
  };
}
