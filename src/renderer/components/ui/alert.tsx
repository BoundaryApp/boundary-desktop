import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

// Callout (ADR 0018): inline status for errors, warnings, notices. One shape
// for every tone so setup, Settings and the workbench speak the same way.
const alertVariants = cva(
  "relative w-full rounded-md border px-3 py-2.5 text-ui leading-snug [&>svg~*]:pl-6 [&>svg]:absolute [&>svg]:left-3 [&>svg]:top-3 [&>svg]:size-4",
  {
    variants: {
      variant: {
        default: "border-line bg-surface-1 text-fg-muted [&>svg]:text-fg-faint",
        info: "border-brand/35 bg-brand-dim/60 text-fg [&>svg]:text-brand",
        ok: "border-ok/35 bg-ok-dim text-fg [&>svg]:text-ok",
        warn: "border-warn/35 bg-warn-dim text-fg [&>svg]:text-warn",
        destructive: "border-danger-line bg-danger-dim text-danger [&>svg]:text-danger",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role={variant === "destructive" || variant === "warn" ? "alert" : "status"}
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
))
Alert.displayName = "Alert"

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("font-medium text-fg", className)} {...props} />
))
AlertTitle.displayName = "AlertTitle"

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-ui [&_p]:leading-relaxed", className)}
    {...props}
  />
))
AlertDescription.displayName = "AlertDescription"

/** Preferred name in product chrome. */
const Callout = Alert

export { Alert, AlertTitle, AlertDescription, Callout, alertVariants }
