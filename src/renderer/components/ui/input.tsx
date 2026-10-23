import * as React from "react"

import { cn } from "../../lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "placeholder:text-fg-faint selection:bg-brand-dim border-line bg-surface-1 text-fg flex h-8 w-full min-w-0 rounded-md border px-2.5 py-1 text-ui transition-[border-color,box-shadow] duration-(--dur-fast) outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-brand/60 focus-visible:shadow-(--focus-ring)",
        "aria-invalid:border-danger-line",
        className
      )}
      {...props}
    />
  )
}

export { Input }
