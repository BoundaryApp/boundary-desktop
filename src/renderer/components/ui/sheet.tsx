import * as React from "react"

import { cn } from "../../lib/utils"
import { useEscapeToClose } from "./use-dismiss"

interface SheetBaseProps {
  open: boolean
  /** Escape calls this, except while `busy`. Cancel buttons call it themselves. */
  onClose: () => void
  /** An action is running: Escape does nothing (callers also disable their buttons). */
  busy?: boolean
  /** Id of the element that names the dialog: `title`'s heading, or one in `children`. */
  titleId: string
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
 * actions, closed by Escape unless busy. Content, wording and buttons stay with the caller.
 */
function Sheet({
  open,
  onClose,
  busy = false,
  titleId,
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
  useEscapeToClose(onClose, busy || !open)
  if (!open) return null

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
    "aria-labelledby": titleId,
  } as const

  return (
    <div className={cn("wb-sheet-backdrop", backdropClassName)} role="presentation">
      {rest.as === "form" ? (
        <form {...dialogProps} onSubmit={rest.onSubmit}>
          {body}
        </form>
      ) : (
        <div {...dialogProps}>{body}</div>
      )}
    </div>
  )
}

export { Sheet }
export type { SheetProps }
