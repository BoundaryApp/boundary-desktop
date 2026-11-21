import * as React from "react"

import { cn } from "../../lib/utils"

import "./control.css"

// A text field drawn by control.css (ADR 0063). `size` picks the height: default is
// --control-height (34px), `sm` is --control-height-sm (28px) for searches and filters in lists,
// menus and docks. It replaces the HTML `size` attribute. Mark a wrong value with `aria-invalid`.
// Put it in a Field for its caption.
function Input({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & { size?: "default" | "sm" }) {
  return <input data-slot="input" data-size={size} className={cn("field-focus", className)} {...props} />
}

export { Input }
