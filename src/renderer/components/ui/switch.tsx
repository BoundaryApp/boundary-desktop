import * as React from "react"

import { cn } from "../../lib/utils"

import "./choice.css"

interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** The accessible name. Leave it out only when a wrapping <label>, a `<label htmlFor>` or `labelledBy` names the switch. */
  label?: string
  /** The id of an element that names the switch, in place of `label`. */
  labelledBy?: string
  /** The id of an element that describes the switch, such as a ChoiceRow's description. */
  describedBy?: string
  /** Lets a `<label htmlFor>` name the switch. */
  id?: string
  disabled?: boolean
  /** Layout only (`ml-auto`, `mt-1`); the look comes from choice.css. */
  className?: string
}

// On/off switch (ADR 0018, ADR 0064): a button with role="switch", drawn by choice.css. It applies
// its value at once, so it has no invalid state.
function Switch({ checked, onChange, label, labelledBy, describedBy, id, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      data-slot="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(className)}
    >
      <span data-slot="switch-thumb" />
    </button>
  )
}

export { Switch }
export type { SwitchProps }
