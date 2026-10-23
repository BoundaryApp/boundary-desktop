import * as React from "react"

import { cn } from "../../lib/utils"

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: React.ReactNode
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  "aria-label": string
  className?: string
}

// Segmented control (ADR 0018): a small radio group for 2–4 exclusive choices.
// Arrow keys move the selection, as with native radio groups.
function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  ...props
}: SegmentedProps<T>) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    onChange(options[next].value)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={props["aria-label"]}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-line bg-surface-1 p-0.5",
        className
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-sm px-3 text-xs font-medium outline-none transition-colors duration-(--dur-fast) focus-visible:shadow-(--focus-ring) [&_svg]:size-3.5",
              selected ? "bg-surface-hover text-fg" : "text-fg-faint hover:text-fg-muted"
            )}
          >
            {option.icon}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export { Segmented }
