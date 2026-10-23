import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatInferenceChipTitle,
  formatInferenceProvenance,
  inferenceSlotLabel,
  isVisibleChatProvider,
} from '../../../shared/inferenceDisplay';
import type {
  ResolvedSessionInference,
  SessionInferenceMark,
} from '../../../shared/types/hermesChat';
import type { InferenceProvidersStatus, InferenceSlotId } from '../../../shared/types/onboarding';
import { hermesChatIPC } from '../../services/hermesChatIPCService';
import { onboardingIPC } from '../../services/onboardingIPCService';
import { CLOUD_INFERENCE_SHORT } from '../cloudInferenceCopy';

const VISIBLE_SLOTS: InferenceSlotId[] = ['local', 'openrouter'];

export interface InferenceChipProps {
  sessionId: string | null;
  disabled?: boolean;
  applying?: boolean;
  /** Fingerprint of active project pin so the chip re-resolves after patch. */
  projectInferenceKey?: string | null;
  onResolvedChange?: (resolved: ResolvedSessionInference | null) => void;
  onMarksChange?: (marks: SessionInferenceMark[]) => void;
}

export const InferenceChip: React.FC<InferenceChipProps> = ({
  sessionId,
  disabled = false,
  applying = false,
  projectInferenceKey = null,
  onResolvedChange,
  onMarksChange,
}) => {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<InferenceProvidersStatus | null>(null);
  const [resolved, setResolved] = useState<ResolvedSessionInference | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const onResolvedChangeRef = useRef(onResolvedChange);
  onResolvedChangeRef.current = onResolvedChange;
  const onMarksChangeRef = useRef(onMarksChange);
  onMarksChangeRef.current = onMarksChange;

  const refresh = useCallback(async () => {
    const nextStatus = await onboardingIPC.getStatus();
    setStatus(nextStatus);
    if (!sessionId) {
      const slot = nextStatus.appDefault;
      const slotStatus = slot ? nextStatus.slots[slot] : undefined;
      const inherited: ResolvedSessionInference | null =
        slot && slotStatus?.configured && slotStatus.modelId
          ? {
              slot,
              modelId: slotStatus.modelId,
              providerDisplayName: slotStatus.providerDisplayName || inferenceSlotLabel(slot),
              provenance: 'app-default',
              configured: true,
              health: slotStatus.health,
              needsRestart: false,
            }
          : null;
      setResolved(inherited);
      onResolvedChangeRef.current?.(inherited);
      onMarksChangeRef.current?.([]);
      return;
    }
    const snapshot = await hermesChatIPC.getSessionInference({ sessionId });
    setResolved(snapshot.resolved);
    onResolvedChangeRef.current?.(snapshot.resolved);
    onMarksChangeRef.current?.(snapshot.marks);
    if (snapshot.resolved?.slot === 'local') {
      await onboardingIPC.probeSlotHealth({ slot: 'local' });
      const probed = await hermesChatIPC.getSessionInference({ sessionId });
      setResolved(probed.resolved);
      onResolvedChangeRef.current?.(probed.resolved);
    }
  }, [sessionId, projectInferenceKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, open]);

  const options = useMemo(() => {
    if (!status) return [];
    return VISIBLE_SLOTS.flatMap((slot) => {
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

  const pick = async (slot: InferenceSlotId, modelId: string) => {
    if (!sessionId || !isVisibleChatProvider(slot)) return;
    await hermesChatIPC.setSessionInference({ sessionId, provider: slot, modelId });
    close();
    await refresh();
  };

  const reset = async () => {
    if (!sessionId) return;
    await hermesChatIPC.clearSessionInference({ sessionId });
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

  const writable = Boolean(sessionId) && !disabled && !applying;

  return (
    <div className="wb-inf-picker" ref={rootRef}>
      <button
        type="button"
        className={`wb-chip wb-chip--inference${open ? ' is-on' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Inference · ${title} · ${provenance}`}
        disabled={!writable}
        title={`${title} · ${provenance}`}
        onClick={() => {
          if (!writable) return;
          setOpen((was) => !was);
          if (!open) void refresh();
        }}
      >
        <b>{title}</b>
        <span>{provenance}</span>
      </button>
      {open ? (
        <div className="wb-inf-menu" role="listbox" aria-label="This chat">
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
          <button type="button" className="wb-inf-reset" onClick={() => void reset()}>
            Use project default
          </button>
        </div>
      ) : null}
    </div>
  );
};
