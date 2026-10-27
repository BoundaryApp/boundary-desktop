import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

/**
 * Popover menus (project picker, ⋯ menus, run menu, jump to date). Radix supplies the
 * dismissal every menu shares: a pointer-down outside or Escape closes it, Escape is
 * consumed so a sheet underneath stays open, focus moves into the menu on open and back
 * to the trigger on close. Content renders in place (no portal), so the workbench's
 * descendant selectors still apply; the caller's class styles it and Radix places it.
 *
 * Open state stays with the caller: pass `open` and `onOpenChange`, and don't toggle it
 * from the trigger's own onClick (the trigger already does).
 */
const Popover = PopoverPrimitive.Root

/** The button that opens the menu; wraps its single child. */
const PopoverTrigger = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Trigger>,
  Omit<React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>, "asChild">
>((props, ref) => <PopoverPrimitive.Trigger ref={ref} asChild {...props} />)
PopoverTrigger.displayName = "PopoverTrigger"

/** Places the menu against something other than its trigger (`virtualRef` or a child). */
const PopoverAnchor = PopoverPrimitive.Anchor

interface PopoverContentProps
  extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  /** Pointer-downs inside this element don't close the menu (a confirm beside it). */
  keepOpenWithin?: React.RefObject<HTMLElement | null>
}

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  PopoverContentProps
>(
  (
    {
      keepOpenWithin,
      sideOffset = 6,
      collisionPadding = 8,
      onPointerDownOutside,
      onFocusOutside,
      onCloseAutoFocus,
      ...props
    },
    ref
  ) => {
    const within = (target: EventTarget | null) =>
      Boolean(keepOpenWithin?.current && target instanceof Node && keepOpenWithin.current.contains(target))
    return (
      <PopoverPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        onPointerDownOutside={(event) => {
          if (within(event.target)) event.preventDefault()
          onPointerDownOutside?.(event)
        }}
        onFocusOutside={(event) => {
          if (within(event.target)) event.preventDefault()
          onFocusOutside?.(event)
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event)
          if (event.defaultPrevented) return
          // An item that moved focus on purpose (Quote focuses the composer, Move opens a
          // sheet) keeps it; otherwise focus returns to the trigger.
          const active = document.activeElement
          if (active && active !== document.body) event.preventDefault()
        }}
        {...props}
      />
    )
  }
)
PopoverContent.displayName = "PopoverContent"

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent }
export type { PopoverContentProps }
