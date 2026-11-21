import * as React from "react"

import { cn } from "../../lib/utils"
import { useChipGroup } from "./chip-group"

import "./toggle.css"

/** `data-*` attributes passed through to the button, such as a tooltip's `data-tip`. */
type DataAttributes = { [key: `data-${string}`]: string | undefined }

/**
 * A filter or tag pill (ADR 0066). In a single ChipGroup it is a radio and needs `value`;
 * anywhere else it is a toggle button and needs `pressed`. Using it the other way throws.
 * `aria-label` names a chip whose visible text doesn't say enough, such as a reaction's count.
 */
function Chip({
  value,
  pressed,
  onPressedChange,
  icon,
  disabled,
  title,
  className,
  children,
  ...attributes
}: {
  value?: string
  pressed?: boolean
  onPressedChange?: (pressed: boolean) => void
  icon?: React.ReactNode
  disabled?: boolean
  title?: string
  className?: string
  children?: React.ReactNode
  "aria-label"?: string
} & DataAttributes) {
  const group = useChipGroup()
  const single = group?.type === "single" ? group : null
  if (import.meta.env.DEV) {
    if (single && value === undefined) throw new Error("Chip in a single ChipGroup needs a value")
    if (!single && pressed === undefined) throw new Error("Chip outside a single ChipGroup needs pressed")
  }

  const own = React.useRef<HTMLButtonElement | null>(null)
  const register = single?.register
  React.useLayoutEffect(() => {
    if (!register || value === undefined || !own.current) return
    return register({ value, disabled: disabled === true, element: own.current })
  }, [register, value, disabled])

  if (single && value !== undefined) {
    const { ref, ...roving } = single.itemProps(value)
    return (
      <button
        type="button"
        role="radio"
        aria-checked={single.value === value}
        data-slot="chip"
        disabled={disabled}
        title={title}
        className={cn(className)}
        {...attributes}
        onClick={() => single.onValueChange(value)}
        {...roving}
        ref={(el) => {
          own.current = el
          ref(el)
        }}
      >
        {icon}
        {children}
      </button>
    )
  }

  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-slot="chip"
      disabled={disabled}
      title={title}
      className={cn(className)}
      {...attributes}
      onClick={() => onPressedChange?.(!pressed)}
    >
      {icon}
      {children}
    </button>
  )
}

export { Chip }
