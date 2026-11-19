import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"
import { Button } from './button'

// Callout (ADR 0018): inline status for errors, warnings, notices. One shape
// for every tone so setup, Settings and the workbench speak the same way.
//
// `layout` places the message and any buttons: `block` is free-form text,
// `row` puts the message (a <p> or <span>) first and the buttons after it on
// one line, and `stacked` puts the buttons, in a `.wb-callout-actions` row,
// under the message. `size="sm"` is for dense chrome like the inspector.
// Spacing around a callout belongs to its container.
const alertVariants = cva(
  "wb-callout relative w-full rounded-md border leading-snug [&_p]:m-0 [&>svg~*]:pl-6 [&>svg]:absolute [&>svg]:left-3 [&>svg]:top-3 [&>svg]:size-4",
  {
    variants: {
      variant: {
        default: "border-line bg-surface-0 text-fg [&>svg]:text-fg-faint",
        info: "border-brand/35 bg-brand-dim/60 text-fg [&>svg]:text-brand",
        ok: "border-ok/35 bg-ok-dim text-fg [&>svg]:text-ok",
        warn: "border-warn/35 bg-warn-dim text-fg [&>svg]:text-warn",
        destructive: "border-danger-line bg-danger-dim text-fg [&>svg]:text-danger",
        code: "border-(--gen)/45 bg-(--gen)/8 text-fg [&>svg]:text-(--gen)",
      },
      layout: {
        block: "",
        row: "flex items-center gap-3 [&>:is(p,span):first-child]:min-w-0 [&>:is(p,span):first-child]:flex-1 [&>button]:shrink-0",
        stacked: "flex flex-col items-start gap-1.5",
      },
      size: {
        default: "px-3 py-2.5 text-ui",
        sm: "px-2.5 py-2 text-xs",
      },
    },
    defaultVariants: {
      variant: "default",
      layout: "block",
      size: "default",
    },
  }
)

/**
 * `role` defaults to `alert` for warn and destructive and `status` otherwise. Pass `role`
 * to choose, or `role={undefined}` for a callout that shouldn't be announced.
 */
const Callout = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, layout, size, ...props }, ref) => (
  <div
    ref={ref}
    role={variant === "destructive" || variant === "warn" ? "alert" : "status"}
    className={cn(alertVariants({ variant, layout, size }), className)}
    {...props}
  />
))
Callout.displayName = "Callout"

/** A load that failed, with Try again beside the message. */
function RetryCallout({ message, onRetry }: { message: React.ReactNode; onRetry: () => void }) {
  return (
    <Callout variant="warn" layout="row" role="alert">
      <span>{message}</span>
      <Button variant="secondary" block type="button" onClick={onRetry}>
        Try again
      </Button>
    </Callout>
  )
}

export { Callout, RetryCallout, alertVariants }
