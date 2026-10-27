import { useEffect, useRef, type RefObject } from "react"

/** Esc closes the open sheet or dialog (ignored while `disabled`, e.g. saving). */
export function useEscapeToClose(onClose: () => void, disabled = false): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (disabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      closeRef.current()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [disabled])
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
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) dismissRef.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      const active = document.activeElement
      const focusWasInside =
        !active || active === document.body || Boolean(ref.current?.contains(active))
      dismissRef.current()
      if (focusWasInside) returnFocusTo?.current?.focus()
    }
    // Capture, so Escape is consumed before window-level handlers (sheets, run stop) see it.
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown, true)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown, true)
    }
  }, [open, ref, returnFocusTo])
}
