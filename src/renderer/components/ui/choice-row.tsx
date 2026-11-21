import * as React from "react"

import { cn } from "../../lib/utils"

import "./choice.css"

/**
 * A choice control with its text beside it, inside one `<label>`, so clicking the text toggles
 * the control (ADR 0064). `card` draws a bordered row tinted while its control is checked;
 * `controlAt="end"` puts the control after the text, for switch rows. A disabled control dims the
 * whole row once.
 */
function ChoiceRow({
  control,
  title,
  description,
  variant = "plain",
  controlAt = "start",
  descriptionId,
  aside,
  className,
}: {
  /** A Checkbox, Radio or Switch. */
  control: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  variant?: "plain" | "card"
  controlAt?: "start" | "end"
  /** An id for the description, so a Switch named by `label` can point `describedBy` at it. */
  descriptionId?: string
  /** A pill or note drawn after the text, centred on the row. Not for `controlAt="end"`. */
  aside?: React.ReactNode
  /** Layout only, such as a margin. */
  className?: string
}) {
  // The control comes first in the DOM wherever it is drawn, so it is the label's control even
  // when the description holds another one (a select, a button); choice.css moves it to the end.
  return (
    <label data-slot="choice-row" data-variant={variant} data-control-at={controlAt} className={cn(className)}>
      <span data-slot="choice-row-control">{control}</span>
      <span data-slot="choice-row-text">
        <span data-slot="choice-row-title">{title}</span>
        {description ? <span id={descriptionId} data-slot="choice-row-description">
            {description}
          </span> : null}
      </span>
      {aside ? <span data-slot="choice-row-aside">{aside}</span> : null}
    </label>
  )
}

export { ChoiceRow }
