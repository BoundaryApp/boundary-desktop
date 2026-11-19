import { useEffect, useRef, type RefObject } from "react"
import { useOwnerDocument, useOwnerWindow } from "./ownerDocument"

/** Esc closes the open sheet or dialog (ignored while `disabled`, e.g. saving). */
export function useEscapeToClose(onClose: () => void, disabled = false): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const win = useOwnerWindow()
  useEffect(() => {
    if (disabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      closeRef.current()
    }
    win.addEventListener("keydown", onKeyDown)
    return () => win.removeEventListener("keydown", onKeyDown)
  }, [disabled, win])
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
