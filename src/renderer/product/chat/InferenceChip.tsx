import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatInferenceChipTitle,
  formatInferenceProvenance,
  inferenceMarkLabel,
  servingFallback,
} from '../../../shared/inferenceDisplay';
import type {
  ChatInferenceProvider,
  ResolvedSessionInference,
  SessionInferenceMark,
} from '../../../shared/types/hermesChat';
import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import { takeInferenceStatus, useInferenceStatus } from '../../onboarding/inferenceStatus';
import { CLOUD_INFERENCE_SHORT } from '../cloudInferenceCopy';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { useCirclesState } from '../circles/useCircles';
import { describeChainEntry, entryIsPrivate, entryKey, type ChainContext } from '../inference/entries';
import { LevelStackSheet } from '../inference/LevelStackSheet';

/** The stack a chat resolves to, first to last: the supplying level's, never merged (ADR 0033 §1). */
function resolvedStack(resolved: ResolvedSessionInference | null): InferenceChainEntry[] {
  if (!resolved?.configured) return [];
  const first: InferenceChainEntry = {
    slot: resolved.slot,
    modelId: resolved.modelId,
    ...(resolved.peer ? { peer: resolved.peer } : {}),
  };
  const seen = new Set([entryKey(first)]);
  return [
    first,
    ...(resolved.fallbacks ?? []).filter((entry) => {
      const key = entryKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

const STACK_SOURCE: Record<ResolvedSessionInference['provenance'], string> = {
  'chat-override': 'This chat’s own stack',
  'project-default': 'From this project’s stack',
  'app-default': 'From the Chat stack',
};

export interface InferenceChipProps {
  sessionId: string | null;
  disabled?: boolean;
  applying?: boolean;
  /** Fingerprint of active project pin so the chip re-resolves after patch. */
  projectInferenceKey?: string | null;
  /** Change it to re-resolve after main's state changed outside the chip (the offline prompt). */
  refreshKey?: number;
  onResolvedChange?: (resolved: ResolvedSessionInference | null) => void;
  onMarksChange?: (marks: SessionInferenceMark[]) => void;
}

export const InferenceChip: React.FC<InferenceChipProps> = ({
  sessionId,
  disabled = false,
  applying = false,
  projectInferenceKey = null,
  refreshKey = 0,
  onResolvedChange,
  onMarksChange,
}) => {
  const [open, setOpen] = useState(false);
  const { status } = useInferenceStatus();
  const [resolved, setResolved] = useState<ResolvedSessionInference | null>(null);
  const [marks, setMarks] = useState<SessionInferenceMark[]>([]);

  const onResolvedChangeRef = useRef(onResolvedChange);
  onResolvedChangeRef.current = onResolvedChange;
  const onMarksChangeRef = useRef(onMarksChange);
  onMarksChangeRef.current = onMarksChange;

  // Only the latest refresh may publish: a slow answer for the previous chat is dropped.
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    const publish = (next: ResolvedSessionInference | null, marks?: SessionInferenceMark[]) => {
      if (mine !== latest.current) return;
      setResolved(next);
      onResolvedChangeRef.current?.(next);
      if (marks) {
        setMarks(marks);
        onMarksChangeRef.current?.(marks);
      }
    };
    try {
      // With no session yet main answers for a new chat: the rail project's pin, else the app
      // default, which is what the first turn will use.
      const snapshot = await window.electronAPI.hermesChat.getSessionInference({
        sessionId: sessionId ?? '',
      });
      publish(snapshot.resolved, snapshot.marks);
      if (snapshot.resolved?.slot !== 'local' || mine !== latest.current) return;
      const probed = await window.electronAPI.onboarding.probeSlotHealth({ slot: 'local' });
      if (probed.status) void takeInferenceStatus(probed);
      publish({ ...snapshot.resolved, health: probed.health });
    } catch {
      publish(null, []);
    }
    // projectInferenceKey and refreshKey change what main answers, not what this asks.
  }, [sessionId, projectInferenceKey, refreshKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Main pushes the local model's health when it changes; a chat on Local takes it, so the
  // offline prompt shows (or clears) without a send or a reopened menu.
  const localHealth = status?.slots.local?.health;
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;
  useEffect(() => {
    const current = resolvedRef.current;
    if (!localHealth || current?.slot !== 'local' || current.health === localHealth) return;
    const next = { ...current, health: localHealth };
    setResolved(next);
    onResolvedChangeRef.current?.(next);
  }, [localHealth]);

  const close = useCallback(() => setOpen(false), []);

  const circles = useCirclesState();
  const [editing, setEditing] = useState(false);
  const privacyLocked = resolved?.privacyLocked === true;
  const privacyRefused = resolved?.privacyRefused === true;
  const stack = useMemo(() => resolvedStack(resolved), [resolved]);

  const reset = async () => {
    if (!sessionId) return;
    try {
      await window.electronAPI.hermesChat.clearSessionInference({ sessionId });
    } catch {
      // The refresh below shows what main kept.
    }
    close();
    await refresh();
  };

  const primaryTitle = !resolved?.configured
    ? 'No provider'
    : resolved.slot === 'peer'
      ? resolved.providerDisplayName
      : formatInferenceChipTitle(resolved.slot, resolved.modelId);
  // Local's health is probed for this chat; a cloud slot's comes with the status main pushes.
  const primaryHealth =
    resolved?.slot === 'openrouter'
      ? status?.slots.openrouter?.health
      : resolved?.slot === 'local'
        ? resolved.health
        : undefined;
  const unreachable = primaryHealth === 'unreachable';
  // A restart or a refused send says more about the next turn than the last one's fallback does.
  const fallback = applying || privacyRefused ? null : servingFallback(resolved, marks);
  const title = fallback ? inferenceMarkLabel(fallback) : primaryTitle;
  const provenance = privacyRefused
    ? 'not private, can’t send'
    : fallback
      ? `fallback for ${primaryTitle}`
      : resolved
        ? formatInferenceProvenance(resolved.provenance, { applying, unreachable })
        : 'from app default';
  // The app default is the expected state, so the chip names only a chat or project
  // override, a restart, or a local server that stopped answering.
  const note = fallback
    ? 'fallback'
    : resolved &&
        (applying || privacyRefused || resolved.provenance !== 'app-default' || provenance === 'unreachable')
      ? provenance
      : null;

  const writable = Boolean(sessionId) && !disabled && !applying;

  // Each entry as the menu lists it. A private project's request stops at the first entry that
  // isn't private (ADR 0033 §4); the rest stay listed so the user sees why they aren't used.
  const ctx: ChainContext = { slots: status?.slots ?? {}, circles };
  const cut = privacyLocked ? stack.findIndex((entry) => !entryIsPrivate(entry, ctx)) : -1;
  const rows = stack.map((entry, index) => {
    const view = describeChainEntry(entry, ctx, index === 0 ? 'first' : 'fallback');
    const label = index === 0 ? primaryTitle : view.label;
    const kind =
      entry.slot === 'peer' ? 'shared in your Circle' : entry.slot === 'local' ? 'on this machine' : CLOUD_INFERENCE_SHORT;
    const detail =
      index === 0 && privacyRefused
        ? 'not private, can’t send'
        : cut >= 0 && index >= cut
          ? 'not used · this project is private'
          : index === 0
            ? unreachable
              ? 'unreachable'
              : kind
            : entry.slot !== 'peer' && view.skipped
              ? 'not connected, skipped'
              : kind;
    return { key: entryKey(entry), label, detail };
  });
  const pinnedProject = Boolean(projectInferenceKey && projectInferenceKey.split(':')[1] !== 'inherit');

  // Saving gives the chat its own stack: levels are not merged (ADR 0033 §1). Main keeps a
  // chat's first entry as a provider, so a shared model can only follow it.
  const saveChatStack = async (list: InferenceChainEntry[]): Promise<string | null> => {
    const [first, ...fallbacks] = list;
    if (!sessionId || !first || first.slot === 'peer') return 'A chat’s stack starts with Local or OpenRouter.';
    const result = await window.electronAPI.hermesChat.setSessionInference({
      sessionId,
      provider: first.slot as ChatInferenceProvider,
      modelId: first.modelId?.trim() || status?.slots[first.slot]?.modelId || '',
      fallbacks,
    });
    await refresh();
    return result.success ? null : (result.error ?? 'Unable to save the stack.');
  };

  return (
    <div className="wb-inf-picker">
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next && !writable) return;
          setOpen(next);
          if (next) void refresh();
        }}
      >
        <PopoverTrigger>
          <button
            type="button"
            className={`wb-chip wb-chip--inference${open ? ' is-on' : ''}${fallback ? ' is-fallback' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`Inference · ${title} · ${provenance}`}
            disabled={!writable}
            title={`${title} · ${provenance}`}
          >
            <b>{title}</b>
            {note ? <span>{note}</span> : null}
          </button>
        </PopoverTrigger>
        <PopoverContent className="wb-inf-menu" role="dialog" aria-label="This chat" side="top" align="start">
          {fallback ? (
            <>
              <div className="wb-inf-kicker">Answering now</div>
              <div className="wb-inf-opt">
                {title}
                <small>{`fallback for ${primaryTitle} · the next send tries it first`}</small>
              </div>
            </>
          ) : null}
          <div className="wb-inf-kicker" id="inference-chip-order">
            This chat tries, in order
          </div>
          {rows.length ? (
            <ol className="wb-inf-order" aria-labelledby="inference-chip-order">
              {rows.map((row, index) => (
                <li key={row.key} className={`wb-inf-opt${index === 0 ? ' is-on' : ''}`}>
                  <span className="wb-inf-order-num" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span>
                    {row.label}
                    <small>{row.detail}</small>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="wb-inf-opt">
              No model
              <small>Connect one in Inference.</small>
            </p>
          )}
          {resolved ? <p className="wb-inf-source">{STACK_SOURCE[resolved.provenance]}</p> : null}
          <button
            type="button"
            className="wb-inf-reset"
            onClick={() => {
              close();
              setEditing(true);
            }}
          >
            Edit stack
          </button>
          {resolved?.provenance === 'chat-override' ? (
            <button type="button" className="wb-inf-reset" onClick={() => void reset()}>
              {pinnedProject ? 'Back to project stack' : 'Back to Chat stack'}
            </button>
          ) : null}
        </PopoverContent>
      </Popover>
      {editing ? (
        <LevelStackSheet
          titleId="inference-chat-stack"
          kicker="This chat"
          title="Stack for this chat"
          lede={`Applies to this chat only. ${pinnedProject ? 'The project’s stack' : 'The Chat stack'} stays as it is.`}
          initial={stack}
          privacyLocked={privacyLocked}
          save={saveChatStack}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
};
