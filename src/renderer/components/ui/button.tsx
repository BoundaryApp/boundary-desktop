import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

// Token-backed buttons (ADR 0018). `default` is the one solid action per view;
// `outline` is the bordered secondary; `ghost` is chrome; `brand` marks a
// recommended path; `destructive` is for irreversible actions.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-ui font-medium transition-[background-color,border-color,color,box-shadow,opacity] duration-(--dur-fast) ease-standard outline-none focus-visible:shadow-(--focus-ring) disabled:pointer-events-none disabled:opacity-50 cursor-pointer [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 aria-invalid:border-danger-line",
  {
    variants: {
      variant: {
        default: "bg-solid text-solid-fg hover:bg-solid/90",
        brand: "bg-brand text-solid-fg hover:bg-brand/90",
        destructive:
          "border border-danger-line bg-transparent text-danger hover:bg-danger-dim",
        outline:
          "border border-line bg-transparent text-fg hover:bg-surface-hover",
        secondary: "bg-surface-hover text-fg hover:bg-surface-2",
        ghost: "text-fg-muted hover:bg-surface-hover hover:text-fg",
        link: "text-fg-muted underline-offset-4 hover:text-fg hover:underline",
      },
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5",
        sm: "h-7 gap-1.5 px-2 text-xs has-[>svg]:px-2",
        lg: "h-10 px-4 has-[>svg]:px-3.5",
        icon: "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
