import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "../../lib/utils"
import { ItemText } from "./menu"

/**
 * A list of options with one active option (ADR 0068): the composer's @ and / lists, a picker
 * under a search field, a destination list in a sheet. Keyboard and ARIA come from
 * `useListNavigation`; spread its `listProps` here when the list itself takes focus. `marks`
 * draws a check column for the selected option, for lists that pick a current value. Rows share
 * the Menu look in menu.css.
 */
const Listbox = React.forwardRef<
  HTMLDivElement,
  Omit<React.HTMLAttributes<HTMLDivElement>, "role"> & { id: string; marks?: boolean }
>(({ marks, className, ...props }, ref) => (
  <div
    ref={ref}
    role="listbox"
    data-slot="listbox"
    data-marks={marks || undefined}
    className={cn(className)}
    {...props}
  />
))
Listbox.displayName = "Listbox"

/** Options under a visible heading that names them (People, Agents, Files). */
function ListboxGroup({
  label,
  className,
  children,
}: {
  label: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  const labelId = React.useId()
  return (
    <div role="group" aria-labelledby={labelId} data-slot="listbox-group" className={cn(className)}>
      <div id={labelId} data-slot="listbox-group-label">
        {label}
      </div>
      {children}
    </div>
  )
}

/**
 * One option. A mouse-down on it keeps focus where it was (the field typing into the list), and
 * a click picks it. `active` is the keyboard's place; `selected` is the value it stands for.
 */
function ListboxOption({
  id,
  active = false,
  selected = false,
  disabled = false,
  onPick,
  icon,
  description,
  hint,
  title,
  className,
  children,
}: {
  id: string
  active?: boolean
  selected?: boolean
  disabled?: boolean
  onPick: () => void
  icon?: React.ReactNode
  description?: React.ReactNode
  hint?: React.ReactNode
  title?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      data-slot="listbox-option"
      data-active={active || undefined}
      title={title}
      className={cn(className)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={disabled ? undefined : onPick}
    >
      <span data-slot="listbox-option-indicator" aria-hidden="true">
        {selected ? <Check size={14} /> : null}
      </span>
      <ItemText description={description} hint={hint} icon={icon}>
        {children}
      </ItemText>
    </div>
  )
}

export { Listbox, ListboxGroup, ListboxOption }
