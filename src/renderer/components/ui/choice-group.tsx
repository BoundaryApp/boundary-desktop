import * as React from "react"

import { cn } from "../../lib/utils"

import "./choice.css"

/**
 * Field for a set of ChoiceRows (ADR 0064): a caption with the Field caption look, the rows, an
 * optional hint, and `.wb-field`'s bottom margin. Radios become a radiogroup, checkboxes a group,
 * named by the caption. A group under a heading that already says what it picks takes
 * `aria-label` instead of `label` and draws no caption (ADR 0066).
 */
function ChoiceGroup({
  kind,
  hint,
  className,
  children,
  ...naming
}: {
  kind: "radio" | "checkbox"
  hint?: React.ReactNode
  className?: string
  children: React.ReactNode
} & ({ label: React.ReactNode; "aria-label"?: never } | { "aria-label": string; label?: never })) {
  const captionId = React.useId()
  const label = naming.label
  return (
    <div
      role={kind === "radio" ? "radiogroup" : "group"}
      aria-labelledby={label === undefined ? undefined : captionId}
      aria-label={naming["aria-label"]}
      data-slot="choice-group"
      className={cn("wb-field", className)}
    >
      {label === undefined ? null : (
        <span id={captionId} className="wb-field-label">
          {label}
        </span>
      )}
      {children}
      {hint ? <p className="wb-field-hint">{hint}</p> : null}
    </div>
  )
}

export { ChoiceGroup }
