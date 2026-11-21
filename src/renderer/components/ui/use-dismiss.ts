import { createContext, useContext, useEffect, useRef, type RefObject } from "react"
import { useOwnerDocument, useOwnerWindow } from "./ownerDocument"

/**
 * How deep the UI under it is nested in sheets. `Sheet` provides its own depth to its
 * children, so a sheet opened inside another one ranks above it whichever mounted first.
 */
export const EscapeDepthContext = createContext(0)

interface EscapeEntry {
  depth: number
  order: number
}

const escapeStacks = new WeakMap<Window, Set<EscapeEntry>>()
let nextOrder = 0

function escapeStack(win: Window): Set<EscapeEntry> {
  let stack = escapeStacks.get(win)
  if (!stack) {
    stack = new Set()
    escapeStacks.set(win, stack)
  }
  return stack
}

/** The deepest entry, and of those the one registered last. */
function topEntry(stack: Set<EscapeEntry>): EscapeEntry | undefined {
  let top: EscapeEntry | undefined
  for (const entry of stack) {
    if (!top || entry.depth > top.depth || (entry.depth === top.depth && entry.order > top.order)) {
      top = entry
    }
  }
  return top
}

/**
 * Esc closes the open sheet or dialog. Only the innermost one that uses this hook acts on a
 * given Escape: a sheet opened inside another closes alone. `disabled` (closed) takes it off
 * the stack; `paused` (saving) keeps its place but ignores Escape, so the sheet under it
 * stays open too. Returns the depth to provide to nested content through
 * `EscapeDepthContext`.
 */
export function useEscapeToClose(onClose: () => void, disabled = false, paused = false): number {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const depth = useContext(EscapeDepthContext) + 1
  const win = useOwnerWindow()
  useEffect(() => {
    if (disabled) return
    const stack = escapeStack(win)
    const entry: EscapeEntry = { depth, order: nextOrder++ }
    stack.add(entry)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (topEntry(stack) !== entry || pausedRef.current) return
      event.preventDefault()
      closeRef.current()
    }
    win.addEventListener("keydown", onKeyDown)
    return () => {
      stack.delete(entry)
      win.removeEventListener("keydown", onKeyDown)
    }
  }, [depth, disabled, win])
  return depth
}

interface DismissOptions {
  /** Where focus goes after Escape, when it was inside the popover. */
  returnFocusTo?: RefObject<HTMLElement | null>
}

/**
 * Closes a popover that isn't a menu (an explainer, a confirm) the way `PopoverContent`
 * closes menus: a pointer-down outside `ref` or Escape. Escape is consumed, so a sheet
 * underneath stays open, and focus goes back to `returnFocusTo` unless it had already
 * left the popover.
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
  { returnFocusTo }: DismissOptions = {}
): void {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  const doc = useOwnerDocument()
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) dismissRef.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      const active = doc.activeElement
      const focusWasInside =
        !active || active === doc.body || Boolean(ref.current?.contains(active))
      dismissRef.current()
      if (focusWasInside) returnFocusTo?.current?.focus()
    }
    // Capture, so Escape is consumed before window-level handlers (sheets, run stop) see it.
    doc.addEventListener("pointerdown", onPointerDown, true)
    doc.addEventListener("keydown", onKeyDown, true)
    return () => {
      doc.removeEventListener("pointerdown", onPointerDown, true)
      doc.removeEventListener("keydown", onKeyDown, true)
    }
  }, [open, ref, returnFocusTo, doc])
}
