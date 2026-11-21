import * as React from "react"

import { X } from "lucide-react"

import { cn } from "../../lib/utils"
import { EscapeDepthContext, useEscapeToClose } from "./use-dismiss"
import { Button } from './button'

interface SheetBaseProps {
  open: boolean
  /**
   * Escape and a click on the backdrop call this, except while `busy`. Cancel buttons
   * call it themselves.
   */
  onClose: () => void
  /** An action is running: Escape and backdrop clicks do nothing (callers also disable their buttons). */
  busy?: boolean
  /** False keeps the sheet open on a backdrop click; Escape still closes it. */
  closeOnBackdrop?: boolean
  /**
   * `dialog` (default) is the centred sheet. `side` is the full-height panel on the right that
   * Settings opens over a screen: its header holds `title` as an `h1` and a close button, it
   * takes focus when it opens and returns it to the opener when it closes, and it leaves out
   * the kicker. It renders as a `div` only.
   */
  variant?: "dialog" | "side"
  /** Id of the element that names the dialog: `title`'s heading, or one in `children`. */
  titleId?: string
  /** Names the dialog instead of `titleId`, and the side variant's close button ("Close …"). */
  label?: string
  /** Small line above the title. */
  kicker?: React.ReactNode
  kickerClassName?: string
  /** The heading. Leave it out when the body renders its own `h2` with `titleId`. */
  title?: React.ReactNode
  /** Beside the title, e.g. an InfoTip; the title text then sits in its own span. */
  titleAside?: React.ReactNode
  /** Shown above the actions. */
  error?: React.ReactNode
  /** The `wb-sheet-actions` row. Leave it out when the body places its own. */
  actions?: React.ReactNode
  actionsClassName?: string
  /** Extra classes on the dialog (`wb-sheet-wide`, …) and on the backdrop. */
  className?: string
  backdropClassName?: string
  children?: React.ReactNode
}

type SheetProps = SheetBaseProps &
  (
    | { as?: "div"; onSubmit?: never }
    | { as: "form"; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }
  )

/**
 * The workbench's modal sheet: backdrop, dialog, kicker, title, body, error line and
 * actions, closed by Escape or a backdrop click unless busy. Escape closes only the innermost
 * open sheet; a busy sheet ignores it and keeps the sheets under it open. Content, wording and buttons stay with the caller.
 */
function Sheet({
  open,
  onClose,
  busy = false,
  closeOnBackdrop = true,
  variant = "dialog",
  titleId,
  label,
  kicker,
  kickerClassName,
  title,
  titleAside,
  error,
  actions,
  actionsClassName,
  className,
  backdropClassName,
  children,
  ...rest
}: SheetProps) {
  const depth = useEscapeToClose(onClose, !open, busy)
  // A click counts only when it both starts and ends on the backdrop, so a text selection
  // dragged out of the dialog doesn't close it.
  const pressedBackdrop = React.useRef(false)
  const sideRef = React.useRef<HTMLDivElement>(null)
  const side = variant === "side"
  React.useEffect(() => {
    if (!open || !side) return
    const opener = sideRef.current?.ownerDocument.activeElement
    sideRef.current?.focus()
    return () => {
      if (opener && "focus" in opener && typeof opener.focus === "function") opener.focus()
    }
  }, [open, side])
  if (!open) return null

  const backdropDismisses = closeOnBackdrop && !busy
  const onBackdropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    pressedBackdrop.current = event.target === event.currentTarget
  }
  const onBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const pressed = pressedBackdrop.current
    pressedBackdrop.current = false
    if (backdropDismisses && pressed && event.target === event.currentTarget) onClose()
  }

  const body = (
    <>
      {kicker != null ? (
        <div className={cn("wb-sheet-kicker", kickerClassName)}>{kicker}</div>
      ) : null}
      {title == null ? null : titleAside ? (
        <h2>
          <span id={titleId}>{title}</span>
          {titleAside}
        </h2>
      ) : (
        <h2 id={titleId}>{title}</h2>
      )}
      {children}
      {error ? <p className="wb-sheet-error">{error}</p> : null}
      {actions ? (
        <div className={cn("wb-sheet-actions", actionsClassName)}>{actions}</div>
      ) : null}
    </>
  )
  const dialogProps = {
    className: cn("wb-sheet", className),
    role: "dialog",
    "aria-modal": true,
    "aria-label": label,
    "aria-labelledby": label ? undefined : titleId,
  } as const

  if (side) {
    return (
      <div
        className={cn("wb-settings-sheet-scrim", backdropClassName)}
        role="presentation"
        onPointerDown={onBackdropPointerDown}
        onClick={onBackdropClick}
      >
        <div
          {...dialogProps}
          ref={sideRef}
          className={cn("wb-settings-sheet", className)}
          tabIndex={-1}
        >
          <header className="wb-settings-sheet-head">
            {title == null ? null : <h1 id={titleId}>{title}</h1>}
            <Button
              type="button"
              variant="quiet"
              size="icon"
              aria-label={label ? `Close ${label}` : "Close"}
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </header>
          <div className="wb-settings-sheet-body">
            <EscapeDepthContext.Provider value={depth}>
              {children}
              {error ? <p className="wb-sheet-error">{error}</p> : null}
              {actions ? (
                <div className={cn("wb-sheet-actions", actionsClassName)}>{actions}</div>
              ) : null}
            </EscapeDepthContext.Provider>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn("wb-sheet-backdrop", backdropClassName)}
      role="presentation"
      onPointerDown={onBackdropPointerDown}
      onClick={onBackdropClick}
    >
      <EscapeDepthContext.Provider value={depth}>
        {rest.as === "form" ? (
          <form {...dialogProps} onSubmit={rest.onSubmit}>
            {body}
          </form>
        ) : (
          <div {...dialogProps}>{body}</div>
        )}
      </EscapeDepthContext.Provider>
    </div>
  )
}

interface SheetConfirmActionsProps {
  /** Disables both buttons while the action runs. */
  busy?: boolean
  onCancel: () => void
  cancelLabel?: React.ReactNode
  /** The confirm button's text, including its busy wording ("Creating…"). */
  confirmLabel: React.ReactNode
  onConfirm: () => void
  /** Also disables the confirm button, e.g. while a required field is empty. */
  confirmDisabled?: boolean
  /** `danger` for an action that removes something. */
  tone?: "solid" | "danger"
  /** After the buttons, e.g. a `wb-sheet-note`. */
  children?: React.ReactNode
}

/** A sheet's Cancel and confirm buttons, for its `actions`. */
function SheetConfirmActions({
  busy = false,
  onCancel,
  cancelLabel = "Cancel",
  confirmLabel,
  onConfirm,
  confirmDisabled = false,
  tone = "solid",
  children,
}: SheetConfirmActionsProps) {
  return (
    <>
      <Button variant="secondary" type="button" disabled={busy} onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button
        variant={tone === "danger" ? "danger" : "primary"}
        type="button"
        disabled={busy || confirmDisabled}
        onClick={onConfirm}
      >
        {confirmLabel}
      </Button>
      {children}
    </>
  )
}

export { Sheet, SheetConfirmActions }
export type { SheetProps }
