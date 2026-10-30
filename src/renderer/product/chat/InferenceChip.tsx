import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatInferenceChipTitle,
  formatInferenceProvenance,
  isVisibleChatProvider,
} from '../../../shared/inferenceDisplay';
import type {
  ChatInferenceProvider,
  ResolvedSessionInference,
  SessionInferenceMark,
} from '../../../shared/types/hermesChat';
import { takeInferenceStatus, useInferenceStatus } from '../../onboarding/inferenceStatus';
import { CLOUD_INFERENCE_SHORT } from '../cloudInferenceCopy';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { FallbackSwitch, fallbackSlotFor, toggledFallbacks } from './FallbackSwitch';

/** The providers a chat can pick, in menu order; see isVisibleChatProvider. */
const CHAT_PROVIDERS: ChatInferenceProvider[] = ['local', 'openrouter'];

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
      if (marks) onMarksChangeRef.current?.(marks);
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

  const options = useMemo(() => {
    if (!status) return [];
    return CHAT_PROVIDERS.flatMap((slot) => {
      const slotStatus = status.slots[slot];
      if (!slotStatus?.configured || !slotStatus.modelId) return [];
      return [
        {
          slot,
          modelId: slotStatus.modelId,
          label: formatInferenceChipTitle(slot, slotStatus.modelId),
        },
      ];
    });
  }, [status]);

  // The fallback of whichever level supplied the model (ADR 0033 §1). Shown when it is on, or
  // when the other provider is connected and could be turned on.
  const fallbackSlot = resolved?.configured ? fallbackSlotFor(resolved.slot) : null;
  const fallbackStatus = fallbackSlot ? status?.slots[fallbackSlot] : undefined;
  const fallbackOn = Boolean(fallbackSlot && resolved?.fallbacks?.some((entry) => entry.slot === fallbackSlot));
  const fallbackReady = Boolean(fallbackStatus?.configured && fallbackStatus.modelId);
  const fallbackDetail = !fallbackReady
    ? 'not connected, skipped'
    : !fallbackOn
      ? 'off · the chat stops and asks'
      : resolved?.provenance === 'chat-override'
        ? 'tried next in this chat'
        : `tried next · ${formatInferenceProvenance(resolved!.provenance)}`;

  // A chat that inherits gets its own override: levels are not merged (ADR 0033 §1).
  const toggleFallback = async () => {
    if (!sessionId || !resolved || !fallbackSlot || !isVisibleChatProvider(resolved.slot)) return;
    try {
      await window.electronAPI.hermesChat.setSessionInference({
        sessionId,
        provider: resolved.slot,
        modelId: resolved.modelId,
        fallbacks: toggledFallbacks(resolved.fallbacks, fallbackSlot, !fallbackOn),
      });
    } catch {
      // The refresh below shows what main kept.
    }
    await refresh();
  };

  const pick = async (slot: ChatInferenceProvider, modelId: string) => {
    if (!sessionId) return;
    try {
      await window.electronAPI.hermesChat.setSessionInference({ sessionId, provider: slot, modelId });
    } catch {
      // The refresh below shows what main kept.
    }
    close();
    await refresh();
  };

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

  const title = resolved?.configured
    ? formatInferenceChipTitle(resolved.slot, resolved.modelId)
    : 'No provider';
  const provenance = resolved
    ? formatInferenceProvenance(resolved.provenance, {
        applying,
        unreachable: resolved.slot === 'local' && resolved.health === 'unreachable',
      })
    : 'from app default';
  // The app default is the expected state, so the chip names only a chat or project
  // override, a restart, or a local server that stopped answering.
  const note =
    resolved && (applying || resolved.provenance !== 'app-default' || provenance === 'unreachable')
      ? provenance
      : null;

  const writable = Boolean(sessionId) && !disabled && !applying;

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
            className={`wb-chip wb-chip--inference${open ? ' is-on' : ''}`}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={`Inference · ${title} · ${provenance}`}
            disabled={!writable}
            title={`${title} · ${provenance}`}
          >
            <b>{title}</b>
            {note ? <span>{note}</span> : null}
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="wb-inf-menu"
          role="listbox"
          aria-label="This chat"
          side="top"
          align="start"
        >
          <div className="wb-inf-kicker">This chat</div>
          {options.map((option) => {
            const selected = resolved?.slot === option.slot;
            const detail =
              selected && resolved.provenance === 'chat-override'
                ? 'overridden for this chat'
                : selected && resolved.provenance === 'project-default'
                  ? 'from project default'
                  : option.slot === status?.appDefault
                    ? 'from app default'
                    : option.slot === 'local'
                      ? 'on this machine'
                      : CLOUD_INFERENCE_SHORT;
            return (
              <button
                key={option.slot}
                type="button"
                role="option"
                aria-selected={selected}
                className={`wb-inf-opt${selected ? ' is-on' : ''}`}
                onClick={() => void pick(option.slot, option.modelId)}
              >
                {option.label}
                <small>{detail}</small>
              </button>
            );
          })}
          {fallbackSlot && (fallbackOn || fallbackReady) ? (
            <>
              <div className="wb-inf-kicker wb-inf-kicker--then">If it doesn't answer</div>
              <FallbackSwitch
                slot={fallbackSlot}
                modelId={fallbackStatus?.modelId}
                on={fallbackOn}
                detail={fallbackDetail}
                onToggle={() => void toggleFallback()}
              />
            </>
          ) : null}
          <button type="button" className="wb-inf-reset" onClick={() => void reset()}>
            Use project default
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
};
