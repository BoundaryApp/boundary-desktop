import * as React from "react"

import { cn } from "../../lib/utils"

import "./choice.css"

// A native checkbox drawn by choice.css (ADR 0064). Put it in a ChoiceRow for its text.
function Checkbox({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return <input type="checkbox" data-slot="checkbox" className={cn(className)} {...props} />
}

export { Checkbox }
