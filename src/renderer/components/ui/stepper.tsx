import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "../../lib/utils"

export interface StepperStep {
  id: string
  label: string
}

interface StepperProps {
  steps: StepperStep[]
  /** Id of the current step; earlier steps render as done. Null = none started. */
  currentId: string | null
  className?: string
}

// Setup progress (ADR 0019): done steps check off in --ok, the current step
// is outlined in --brand, later steps stay faint.
function Stepper({ steps, currentId, className }: StepperProps) {
  const current = currentId ? steps.findIndex((step) => step.id === currentId) : -1

  return (
    <ol aria-label="Setup progress" className={cn("flex items-center gap-2 text-xs", className)}>
      {steps.map((step, index) => {
        const done = current > index
        const active = current === index
        return (
          <li key={step.id} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
            {index > 0 && <span aria-hidden="true" className="h-px w-6 bg-line" />}
            <span
              className={cn(
                "inline-flex items-center gap-1.5 transition-colors duration-(--dur-fast)",
                done ? "text-fg-muted" : active ? "font-medium text-fg" : "text-fg-faint"
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-[18px] place-items-center rounded-full border text-2xs tabular-nums",
                  done
                    ? "border-ok/40 bg-ok-dim text-ok"
                    : active
                      ? "border-brand text-brand"
                      : "border-line"
                )}
              >
                {done ? <Check className="size-3" strokeWidth={2.5} /> : index + 1}
              </span>
              {step.label}
              {done && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export { Stepper }
