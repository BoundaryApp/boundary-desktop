import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

// Pill (ADR 0018): short status or label. `dot` adds a leading status dot.
const badgeVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 [&>svg]:pointer-events-none overflow-hidden",
  {
    variants: {
      variant: {
        default: "border-line bg-surface-1 text-fg-muted",
        brand: "border-brand/40 bg-brand-dim text-brand",
        ok: "border-ok/35 bg-ok-dim text-ok",
        warn: "border-warn/35 bg-warn-dim text-warn",
        destructive: "border-danger-line bg-danger-dim text-danger",
        secondary: "border-transparent bg-surface-hover text-fg-muted",
        outline: "border-line bg-transparent text-fg-muted",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  dot = false,
  asChild = false,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean; dot?: boolean }) {
  const Comp = asChild ? Slot : "span"

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      {dot && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
      {children}
    </Comp>
  )
}

/** Preferred name in product chrome. */
const Pill = Badge

export { Badge, Pill, badgeVariants }
