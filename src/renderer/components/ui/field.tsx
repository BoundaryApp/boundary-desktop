import * as React from "react"

import { cn } from "../../lib/utils"

/**
 * A labelled form control in a sheet: a short caption, the control, then an optional hint. The
 * spacing between the three, and below the field, comes from `.wb-field`, so fields stack evenly
 * whatever sits around them. Put a sentence in `hint`, not in `label`.
 */
function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: React.ReactNode
  /** The control's id, so the caption names it. */
  htmlFor: string
  hint?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("wb-field", className)}>
      <label htmlFor={htmlFor} className="wb-field-label">
        {label}
      </label>
      {children}
      {hint ? <p className="wb-field-hint">{hint}</p> : null}
    </div>
  )
}

export { Field }
