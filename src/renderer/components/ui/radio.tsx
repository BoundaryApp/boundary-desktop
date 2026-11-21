import * as React from "react"

import { cn } from "../../lib/utils"

import "./choice.css"

// A native radio drawn by choice.css (ADR 0064). `name` is required: radios group by it, which
// keeps one checked and lets arrow keys move between them. Put each in a ChoiceRow and the set
// in a ChoiceGroup.
function Radio({
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type" | "name"> & { name: string }) {
  return <input type="radio" data-slot="radio" className={cn(className)} {...props} />
}

export { Radio }
