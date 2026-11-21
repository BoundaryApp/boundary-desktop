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
// .wb-btn-brand, .wb-btn-link) and the modifiers .is-sm, .is-icon, .is-icon-sm, .is-icon-xs,
// .is-danger and .is-block. Heights come from tokens.css: --control-height (34px) and
// --control-height-sm (28px). A Button sizes to its label; `block` fills its column.
// Icon buttons are squares: `icon` 34px, `icon-sm` 28px, `icon-xs` 24px (--control-height-xs), for
// row actions and buttons inside chips. They need an accessible name (aria-label or
// aria-labelledby) and are `quiet` unless they need a border. A button that opens a menu or panel
// says aria-expanded, which draws the open look.
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
        "icon-sm": "is-icon is-icon-sm",
        "icon-xs": "is-icon is-icon-xs rounded-sm [&_svg:not([class*='size-'])]:size-3.5",
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
      { variant: "secondary", size: ["default", "icon", "icon-sm", "icon-xs"], class: "wb-btn-ghost" },
      { variant: "secondary", size: "sm", class: "wb-btn-tiny" },
      { variant: "danger", size: ["default", "icon", "icon-sm", "icon-xs"], class: "wb-btn-danger" },
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
  const unnamedIcon =
    !asChild && size?.startsWith("icon") === true && !props["aria-label"] && !props["aria-labelledby"]
  React.useEffect(() => {
    if (import.meta.env.DEV && unnamedIcon) {
      console.error("An icon Button needs aria-label or aria-labelledby: it shows no text to name it.")
    }
  }, [unnamedIcon])

  return (
    <Comp
      data-slot="button"
      data-size={size ?? undefined}
      className={cn(buttonVariants({ variant, size, block, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
