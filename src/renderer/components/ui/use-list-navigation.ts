import type * as React from "react"

/**
 * Keyboard and ARIA for a Listbox with one active option (ADR 0068), in two modes.
 *
 * - `fieldProps` go on a text field that keeps focus while the list is open (the composer's
 *   @ and / lists, a search field above a list): the field becomes a combobox that names the
 *   list and its active option. ArrowUp and ArrowDown move the active option and wrap, Enter
 *   picks it, Escape calls `onClose` and is consumed so a sheet underneath stays open. Home and
 *   End stay with the text.
 * - `listProps` go on the Listbox itself when it is the focus target (a list in a sheet): one
 *   Tab stop, and arrows, Home and End move the active option, which the caller usually also
 *   selects.
 *
 * The caller owns `active`; this hook only reads it and asks for changes. `handleKeyDown`
 * returns whether it took the key, for a field that already has its own key handler.
 */
function useListNavigation({
  id,
  open,
  count,
  active,
  onActiveChange,
  onPick,
  onClose,
  isDisabled,
  loop = true,
}: {
  /** The Listbox's id; option ids derive from it. */
  id: string
  open: boolean
  count: number
  /** Index of the active option, or -1 for none. */
  active: number
  onActiveChange: (index: number) => void
  onPick?: (index: number) => void
  onClose?: () => void
  isDisabled?: (index: number) => boolean
  loop?: boolean
}) {
  const optionId = (index: number) => `${id}-option-${index}`
  const enabled = Array.from({ length: count }, (_, i) => i).filter((i) => !isDisabled?.(i))

  const step = (by: 1 | -1): number | undefined => {
    if (enabled.length === 0) return undefined
    const at = enabled.indexOf(active)
    if (at === -1) return by === 1 ? enabled[0] : enabled[enabled.length - 1]
    const next = at + by
    if (next < 0) return loop ? enabled[enabled.length - 1] : enabled[0]
    if (next >= enabled.length) return loop ? enabled[0] : enabled[enabled.length - 1]
    return enabled[next]
  }

  const move = (event: React.KeyboardEvent, target: number | undefined): true => {
    event.preventDefault()
    if (target !== undefined && target !== active) onActiveChange(target)
    return true
  }

  const handleKeyDown = (event: React.KeyboardEvent, withEnds = false): boolean => {
    if (!open) return false
    switch (event.key) {
      case "ArrowDown":
        return move(event, step(1))
      case "ArrowUp":
        return move(event, step(-1))
      case "Home":
        return withEnds ? move(event, enabled[0]) : false
      case "End":
        return withEnds ? move(event, enabled[enabled.length - 1]) : false
      case "Enter":
        if (!onPick || active < 0 || isDisabled?.(active)) return false
        event.preventDefault()
        onPick(active)
        return true
      case "Escape":
        if (!onClose) return false
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return true
      default:
        return false
    }
  }

  const activeDescendant = open && active >= 0 && active < count ? optionId(active) : undefined

  const fieldProps = {
    role: "combobox" as const,
    "aria-expanded": open,
    "aria-controls": open ? id : undefined,
    "aria-autocomplete": "list" as const,
    "aria-activedescendant": activeDescendant,
    onKeyDown: (event: React.KeyboardEvent) => {
      handleKeyDown(event)
    },
  }

  const listProps = {
    tabIndex: 0,
    "aria-activedescendant": activeDescendant,
    onKeyDown: (event: React.KeyboardEvent) => {
      handleKeyDown(event, true)
    },
  }

  return { fieldProps, listProps, optionId, handleKeyDown }
}

export { useListNavigation }
