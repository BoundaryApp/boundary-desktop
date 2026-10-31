import { useMemo } from 'react';
import { useAuiState } from '@assistant-ui/store';
import type {
  HermesNoReply,
  HermesNoReplyReason,
  HermesReplyEnding,
} from '../../../shared/types/hermesChat';
import type { KanbanFiledTask } from '../../../shared/types/hermesKanban';
import type { SpeakerSegment } from './speakerSegments';

/**
 * What Boundary keeps on a transcript message's `metadata.custom`. History writes it in
 * `toThreadMessage`, a live turn in the chat model adapter; readers go through
 * `messageCustom`, which keeps only values of the right shape.
 */
export interface HermesMessageCustom {
  /** When the message was stored, unix seconds; null when the source has no time. */
  ts?: number | null;
  /** Durable Hermes transcript row id; null when the row has none. */
  rowId?: number | null;
  /** Paths the turn's tools wrote. */
  files?: string[];
  /** Kanban tasks the turn filed. */
  tasksFiled?: KanbanFiledTask[];
  /** Tools run in the turn, when known. */
  toolCount?: number;
  /** How a cut-short reply ended. */
  ending?: HermesReplyEnding;
  /** Why a turn ended with no reply. */
  noReply?: HermesNoReply;
  /** A failed send from Boundary's record: Hermes has no row for it. */
  localOnly?: true;
  /** Who spoke this reply in a room. */
  agentSlug?: string;
  /** Each agent's part of a live room wake. */
  segments?: SpeakerSegment[];
  /**
   * The empty reply the chat runtime adds for a room post that woke nobody; the thread
   * doesn't draw it.
   */
  roomPost?: true;
}

const NO_REPLY_REASONS: ReadonlySet<string> = new Set<HermesNoReplyReason>([
  'stopped',
  'interrupted',
  'failed',
  'halted',
  'timeout',
  'empty',
  'unreachable',
  'unknown',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function noReplyOf(value: unknown): HermesNoReply | undefined {
  if (!isRecord(value) || typeof value.reason !== 'string') return undefined;
  if (!NO_REPLY_REASONS.has(value.reason)) return undefined;
  const reason = value.reason as HermesNoReplyReason;
  return {
    reason,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
  };
}

function segmentsOf(value: unknown): SpeakerSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.every(
    (s) =>
      isRecord(s) &&
      typeof s.text === 'string' &&
      (s.agentSlug === null || typeof s.agentSlug === 'string')
  );
  return valid ? (value as SpeakerSegment[]) : undefined;
}

type MessageWithCustom = { metadata?: { custom?: Record<string, unknown> } } | undefined;

/** A message's `metadata.custom`, keeping only the keys whose values have the right shape. */
export function messageCustom(message: MessageWithCustom): HermesMessageCustom {
  return readCustom(message?.metadata?.custom);
}

function readCustom(raw: unknown): HermesMessageCustom {
  if (!isRecord(raw)) return {};
  const out: HermesMessageCustom = {};
  if (typeof raw.ts === 'number') out.ts = raw.ts;
  else if (raw.ts === null) out.ts = null;
  if (typeof raw.rowId === 'number') out.rowId = raw.rowId;
  else if (raw.rowId === null) out.rowId = null;
  if (Array.isArray(raw.files)) {
    const files = raw.files.filter((f): f is string => typeof f === 'string');
    if (files.length > 0) out.files = files;
  }
  if (Array.isArray(raw.tasksFiled)) out.tasksFiled = raw.tasksFiled as KanbanFiledTask[];
  if (typeof raw.toolCount === 'number') out.toolCount = raw.toolCount;
  if (raw.ending === 'stopped' || raw.ending === 'interrupted') out.ending = raw.ending;
  const noReply = noReplyOf(raw.noReply);
  if (noReply) out.noReply = noReply;
  if (raw.localOnly === true) out.localOnly = true;
  if (typeof raw.agentSlug === 'string') out.agentSlug = raw.agentSlug;
  const segments = segmentsOf(raw.segments);
  if (segments) out.segments = segments;
  if (raw.roomPost === true) out.roomPost = true;
  return out;
}

/**
 * The current message's custom data, inside a message component. It is read once per change
 * of the stored object, so object values (noReply, segments) keep their identity between renders.
 */
export function useMessageCustom(): HermesMessageCustom {
  const raw = useAuiState((s) => s.message.metadata?.custom);
  return useMemo(() => readCustom(raw), [raw]);
}
