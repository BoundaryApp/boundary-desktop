import * as React from "react"

import { cn } from "../../lib/utils"

import "./control.css"

// A text area drawn by control.css (ADR 0063). `field` is the bordered box for sheets and task
// cards, at least --textarea-min-height tall and resizable by height. `bare` has no border,
// background, padding, focus ring or resize: for a composer whose container draws the box. It
// sets no height, so the composer's own class and autosizing decide it.
function Textarea({
  className,
  variant = "field",
  ...props
}: React.ComponentProps<"textarea"> & { variant?: "field" | "bare" }) {
  return (
    <textarea
      data-slot="textarea"
      data-variant={variant}
      className={cn(variant === "field" && "field-focus", className)}
      {...props}
    />
  )
}

export { Textarea }
