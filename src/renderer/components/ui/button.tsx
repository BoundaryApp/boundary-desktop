import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

import "./button.css"

// Token-backed buttons (ADR 0018, ADR 0061). `primary` is the one solid action per view;
// `secondary` is the bordered button (small: the muted small button); `danger` deletes,
// removes or leaves; `quiet` is borderless chrome; `brand` marks a recommended path; `link`
// reads as text. Every variant maps to classes in button.css: .wb-btn on every Button, one look
// class (.wb-btn-solid, .wb-btn-ghost, .wb-btn-tiny, .wb-btn-danger, .wb-btn-quiet,
// .wb-btn-brand, .wb-btn-link) and the modifiers .is-sm, .is-icon, .is-danger and .is-block.
// Heights come from tokens.css: --control-height (34px) and --control-height-sm (28px).
// A Button sizes to its label; `block` fills its column.
const buttonVariants = cva(
  "wb-btn inline-flex items-center justify-center whitespace-nowrap rounded-md control-transition outline-none focus-visible:shadow-(--focus-ring) disabled:pointer-events-none cursor-pointer [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 aria-invalid:border-danger-line",
  {
    variants: {
      variant: {
        primary: "wb-btn-solid",
        secondary: "",
        danger: "",
        quiet: "wb-btn-quiet",
        brand: "wb-btn-brand",
        link: "wb-btn-link",
      },
      size: {
        default: "",
        sm: "is-sm",
        icon: "is-icon",
      },
      // A block button may shrink: like the full-width workbench buttons, block buttons in a
      // flex row split it instead of each taking the whole row.
      block: {
        true: "is-block shrink",
        false: "",
      },
    },
    compoundVariants: [
      // The small bordered and small danger buttons share .wb-btn-tiny.
      { variant: "secondary", size: ["default", "icon"], class: "wb-btn-ghost" },
      { variant: "secondary", size: "sm", class: "wb-btn-tiny" },
      { variant: "danger", size: ["default", "icon"], class: "wb-btn-danger" },
      { variant: "danger", size: "sm", class: "wb-btn-tiny is-danger" },
    ],
    defaultVariants: {
      variant: "primary",
      size: "default",
      block: false,
    },
  }
)

function Button({
  className,
  variant,
  size,
  block,
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
      className={cn(buttonVariants({ variant, size, block, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
