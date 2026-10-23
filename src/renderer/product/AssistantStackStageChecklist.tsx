import React from 'react';
import { Check } from 'lucide-react';
import {
  ASSISTANT_STACK_STAGE_LABELS,
  ASSISTANT_STACK_START_STAGES,
} from '../../shared/assistantStackLifecycle';
import type { AssistantStackLifecycleStage } from '../../shared/types/assistantStack';

export interface AssistantStackStageChecklistProps {
  stage?: AssistantStackLifecycleStage;
}

function stageIndex(stage: AssistantStackLifecycleStage | undefined): number {
  if (!stage || stage === 'idle' || stage === 'error') return -1;
  return ASSISTANT_STACK_START_STAGES.indexOf(stage);
}

export const AssistantStackStageChecklist: React.FC<AssistantStackStageChecklistProps> = ({
  stage,
}) => {
  const current = stageIndex(stage);
  if (current < 0 && stage !== 'ready') {
    return null;
  }

  return (
    <ol
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs"
      aria-label="Assistant stack setup stages"
    >
      {ASSISTANT_STACK_START_STAGES.map((id, index) => {
        const done = stage === 'ready' || (current >= 0 && index < current);
        const active = stage !== 'ready' && index === current;
        const label = ASSISTANT_STACK_STAGE_LABELS[id];
        return (
          <li
            key={id}
            className={`inline-flex items-center gap-1.5 transition-colors duration-(--dur-fast) ${
              done ? 'text-fg-muted' : active ? 'text-fg' : 'text-fg-faint'
            }`}
            aria-current={active ? 'step' : undefined}
          >
            <span
              className={`flex size-4 items-center justify-center rounded-full border text-[10px] tabular-nums ${
                done
                  ? 'border-ok/40 bg-ok-dim text-ok'
                  : active
                    ? 'border-brand text-brand'
                    : 'border-line'
              }`}
              aria-hidden
            >
              {done ? <Check className="size-2.5" strokeWidth={3} /> : index + 1}
            </span>
            <span className={active ? 'font-medium' : undefined}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
};
