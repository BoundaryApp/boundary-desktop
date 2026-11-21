import * as React from "react"

import { cn } from "../../lib/utils"
import { useRovingRadio } from "./use-roving-radio"

import "./toggle.css"

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: React.ReactNode
  disabled?: boolean
  /** Why the option is unavailable, shown on hover. */
  title?: string
}

type SegmentedProps<T extends string> = {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  size?: "default" | "sm"
  /** Stretch the track to its container and split it evenly. */
  block?: boolean
  disabled?: boolean
  className?: string
} & ({ "aria-label": string; "aria-labelledby"?: never } | { "aria-labelledby": string; "aria-label"?: never })

// Segmented control (ADR 0018, ADR 0066): a radio group for 2–4 short exclusive options. Arrow
// keys select as they move, as with native radio groups. Its look is toggle.css.
function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "default",
  block,
  disabled,
  className,
  ...labels
}: SegmentedProps<T>) {
  const { itemProps } = useRovingRadio({
    values: options.map((option) => option.value),
    value,
    isDisabled: (v) => disabled || options.find((option) => option.value === v)?.disabled === true,
    onChange,
  })

  return (
    <div
      role="radiogroup"
      aria-label={labels["aria-label"]}
      aria-labelledby={labels["aria-labelledby"]}
      aria-disabled={disabled || undefined}
      data-slot="segmented"
      data-size={size}
      data-block={block ? "" : undefined}
      className={cn(className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          data-slot="segmented-item"
          disabled={disabled || option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
          {...itemProps(option.value)}
        >
          {option.icon}
          <span data-slot="segmented-label">{option.label}</span>
        </button>
      ))}
    </div>
  )
}

export { Segmented }
