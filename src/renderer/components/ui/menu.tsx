import * as React from "react"
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu"
import { Check, ChevronRight } from "lucide-react"

import { cn } from "../../lib/utils"
import { useOwnerDocument } from "./ownerDocument"

import "./menu.css"

/**
 * A menu of actions or checkable choices that takes focus while open (ADR 0068), on Radix
 * DropdownMenu: arrow keys that wrap and skip disabled items, typeahead, submenus on
 * ArrowRight and ArrowLeft, Escape that closes and returns focus to the trigger, and the
 * outside pointer-down dismissal PopoverContent has. Non-modal and rendered in place, as
 * popovers are, so the rest of the window stays reachable and `ownerDocument` holds.
 *
 * Open state stays with the caller: pass `open` and `onOpenChange`. Radix opens the menu on a
 * primary pointer-down on the trigger, or Enter, Space or ArrowDown; tests use `openMenu`.
 */
function Menu({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  return (
    <MenuPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      {children}
    </MenuPrimitive.Root>
  )
}

/** The button that opens the menu; wraps its single child and gives it aria-haspopup and aria-expanded. */
const MenuTrigger = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Trigger>,
  Omit<React.ComponentPropsWithoutRef<typeof MenuPrimitive.Trigger>, "asChild">
>((props, ref) => <MenuPrimitive.Trigger ref={ref} asChild {...props} />)
MenuTrigger.displayName = "MenuTrigger"

/**
 * An item that moved focus on purpose (Quote focuses the composer, Move opens a sheet) keeps
 * it when the menu closes; otherwise focus returns to the trigger.
 *
 * After a press or focus outside the menu, Radix leaves focus where it went and resets its own
 * outside flag in the same handler, so that close is left to Radix. Preventing it would leave
 * the flag set, and the next Escape would drop focus on the body instead of the trigger.
 */
function useKeepMovedFocus(
  onCloseAutoFocus?: (event: Event) => void,
  onInteractOutside?: React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content>["onInteractOutside"]
) {
  const ownerDocument = useOwnerDocument()
  const interactedOutside = React.useRef(false)
  return {
    onInteractOutside: (event: Parameters<NonNullable<typeof onInteractOutside>>[0]) => {
      onInteractOutside?.(event)
      if (!event.defaultPrevented) interactedOutside.current = true
    },
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event)
      const outside = interactedOutside.current
      interactedOutside.current = false
      if (event.defaultPrevented || outside) return
      const content = event.target instanceof Node ? event.target : null
      const active = ownerDocument.activeElement
      if (active && active !== ownerDocument.body && !content?.contains(active)) event.preventDefault()
    },
  }
}

const MenuContent = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
>(({ className, sideOffset = 6, collisionPadding = 8, loop = true, onCloseAutoFocus, onInteractOutside, ...props }, ref) => {
  const keepMovedFocus = useKeepMovedFocus(onCloseAutoFocus, onInteractOutside)
  return (
    <MenuPrimitive.Content
      ref={ref}
      data-slot="menu-content"
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      loop={loop}
      onCloseAutoFocus={keepMovedFocus.onCloseAutoFocus}
      onInteractOutside={keepMovedFocus.onInteractOutside}
      className={cn(className)}
      // Radix names the menu after its trigger; an aria-label given here wins instead.
      {...(props["aria-label"] ? { "aria-labelledby": undefined } : null)}
      {...props}
    />
  )
})
MenuContent.displayName = "MenuContent"

export interface ItemTextProps {
  /** A second line under the label, in --text-muted. */
  description?: React.ReactNode
  /** Right-aligned text after the label: a shortcut or a count. */
  hint?: React.ReactNode
  /** A 14px icon before the label. */
  icon?: React.ReactNode
  children: React.ReactNode
}

/** The icon, label, description and hint inside a menu row or listbox option. */
export function ItemText({ description, hint, icon, children }: ItemTextProps) {
  return (
    <>
      {icon ? (
        <span data-slot="menu-item-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span data-slot="menu-item-text">
        <span data-slot="menu-item-label">{children}</span>
        {description ? <span data-slot="menu-item-description">{description}</span> : null}
      </span>
      {hint ? <span data-slot="menu-item-hint">{hint}</span> : null}
    </>
  )
}

/** The check column checkable items draw, so their labels line up checked or not. */
function Indicator() {
  return (
    <span data-slot="menu-item-indicator" aria-hidden="true">
      <MenuPrimitive.ItemIndicator>
        <Check size={14} />
      </MenuPrimitive.ItemIndicator>
    </span>
  )
}

/** A checkbox or radio item's body: the check column, then the text. */
function Checkable(props: ItemTextProps) {
  return (
    <>
      <Indicator />
      <ItemText {...props} />
    </>
  )
}

type ItemBase = ItemTextProps & {
  disabled?: boolean
  title?: string
  className?: string
}

const MenuItem = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Item>,
  ItemBase & { onSelect: (event: Event) => void; variant?: "default" | "danger" }
>(({ onSelect, variant = "default", disabled, title, className, description, hint, icon, children }, ref) => (
  <MenuPrimitive.Item
    ref={ref}
    data-slot="menu-item"
    data-variant={variant}
    disabled={disabled}
    title={title}
    className={cn(className)}
    onSelect={onSelect}
  >
    <ItemText description={description} hint={hint} icon={icon}>
      {children}
    </ItemText>
  </MenuPrimitive.Item>
))
MenuItem.displayName = "MenuItem"

/** Splits an item's props into the row's own attributes and its text. */
function splitItem({ disabled, title, className, ...text }: ItemBase) {
  return [{ "data-slot": "menu-item", disabled, title, className: cn(className) }, text] as const
}

const MenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.CheckboxItem>,
  ItemBase & { checked: boolean; onCheckedChange: (checked: boolean) => void }
>(({ checked, onCheckedChange, ...item }, ref) => {
  const [row, text] = splitItem(item)
  return (
    <MenuPrimitive.CheckboxItem ref={ref} checked={checked} onCheckedChange={onCheckedChange} {...row}>
      <Checkable {...text} />
    </MenuPrimitive.CheckboxItem>
  )
})
MenuCheckboxItem.displayName = "MenuCheckboxItem"

function MenuRadioGroup({
  value,
  onValueChange,
  children,
}: {
  value: string
  onValueChange: (value: string) => void
  children: React.ReactNode
}) {
  return (
    <MenuPrimitive.RadioGroup data-slot="menu-radio-group" value={value} onValueChange={onValueChange}>
      {children}
    </MenuPrimitive.RadioGroup>
  )
}

const MenuRadioItem = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.RadioItem>,
  ItemBase & { value: string }
>(({ value, ...item }, ref) => {
  const [row, text] = splitItem(item)
  return (
    <MenuPrimitive.RadioItem ref={ref} value={value} {...row}>
      <Checkable {...text} />
    </MenuPrimitive.RadioItem>
  )
})
MenuRadioItem.displayName = "MenuRadioItem"

/** A heading inside the menu that focus skips ("This chat writes in"). */
function MenuLabel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <MenuPrimitive.Label data-slot="menu-label" className={cn(className)}>
      {children}
    </MenuPrimitive.Label>
  )
}

/** Text under an item that focus skips: why the item above is disabled. */
function MenuNote({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <p data-slot="menu-note" className={cn(className)}>
      {children}
    </p>
  )
}

function MenuSeparator({ className }: { className?: string }) {
  return <MenuPrimitive.Separator data-slot="menu-separator" className={cn(className)} />
}

const MenuSub = MenuPrimitive.Sub

const MenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.SubTrigger>,
  Omit<ItemBase, "description">
>(({ disabled, title, className, hint, icon, children }, ref) => (
  <MenuPrimitive.SubTrigger
    ref={ref}
    data-slot="menu-item"
    disabled={disabled}
    title={title}
    className={cn(className)}
  >
    <ItemText hint={hint} icon={icon}>
      {children}
    </ItemText>
    <span data-slot="menu-item-chevron" aria-hidden="true">
      <ChevronRight size={14} />
    </span>
  </MenuPrimitive.SubTrigger>
))
MenuSubTrigger.displayName = "MenuSubTrigger"

const MenuSubContent = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.SubContent>
>(({ className, sideOffset = 2, collisionPadding = 8, loop = true, ...props }, ref) => (
  <MenuPrimitive.SubContent
    ref={ref}
    data-slot="menu-content"
    sideOffset={sideOffset}
    collisionPadding={collisionPadding}
    loop={loop}
    className={cn(className)}
    {...props}
  />
))
MenuSubContent.displayName = "MenuSubContent"

export {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuItem,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuLabel,
  MenuNote,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuSubContent,
}
