import * as React from "react"

interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** The accessible name. Leave it out only when a wrapping <label> or `labelledBy` names the switch. */
  label?: string
  /** The id of an element that names the switch, in place of `label`. */
  labelledBy?: string
  disabled?: boolean
  /** Replaces the default `wb-switch` look; `is-on` is added while checked. */
  className?: string
}

// On/off switch (ADR 0018): a button with role="switch", styled by the wb-switch CSS.
function Switch({ checked, onChange, label, labelledBy, disabled, className = "wb-switch" }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`${className}${checked ? " is-on" : ""}`}
    >
      <i />
    </button>
  )
}

export { Switch }
export type { SwitchProps }
