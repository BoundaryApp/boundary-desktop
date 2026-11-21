import * as React from "react"

import { cn } from "../../lib/utils"

import "./control.css"

// A native <select> drawn by control.css (ADR 0063), for forms, settings rows and toolbars. The
// open list is the system menu, which can pass the edge of a small window such as the desktop
// agent panel. Use the Radix Select only for options that need more than one line of text.
// `size` is default (34px, fills its column) or `sm` (28px, sizes to its options). The caret
// comes from index.css's base layer.
function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "default" | "sm" }) {
  return <select data-slot="native-select" data-size={size} className={cn("field-focus", className)} {...props} />
}

export { NativeSelect }
