import * as React from "react"

import { cn } from "../../lib/utils"

/** Enter on these does its own thing (press a button, submit a form, follow a link). */
function handlesEnter(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("button, a[href], input, textarea, select, [role='menuitem']"))
  )
}

interface InterruptCardBaseProps {
  /** Extra class on the card (`wb-credential`, `wb-coding-access`, `is-menu`). */
  className?: string
  /** Id of the element that names the card: the kicker (`kickerId`) or a heading in it. */
  labelledBy: string
  describedBy?: string
  kicker: React.ReactNode
  /** Put on the kicker text when it is what names the card. */
  kickerId?: string
  /** Tooltip for a kicker that may be cut off; defaults to the kicker when it is text. */
  kickerTitle?: string
  /** Amber kicker (credential requests, smart-denied approvals). */
  warn?: boolean
  /** Interrupts waiting, this one included; 2 or more shows "1 / N" and stacks the card. */
  queueSize: number
  /** A response is being sent: keys do nothing. */
  busy?: boolean
  /** Escape, anywhere in the card or beside it: deny, skip or dismiss. */
  onEscape: () => void
  /** Enter outside a button or field: the card's default action. */
  onEnter?: () => void
  /** Drawn beside the card in the composer slot (the Always allow confirm). */
  aside?: React.ReactNode
  hostRef?: React.Ref<HTMLDivElement>
  children: React.ReactNode
}

type InterruptCardProps = InterruptCardBaseProps &
  (
    | { as?: "div"; onSubmit?: never }
    | { as: "form"; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }
  )

/**
 * The frame of a composer interrupt (ADR 0006's slot): the alertdialog card with its
 * kicker and queue count, and the keys every interrupt shares. Escape always stays in
 * the card, so it never reaches the thread's stop-run shortcut.
 */
function InterruptCard({
  className,
  labelledBy,
  describedBy,
  kicker,
  kickerId,
  kickerTitle,
  warn = false,
  queueSize,
  busy = false,
  onEscape,
  onEnter,
  aside,
  hostRef,
  children,
  ...rest
}: InterruptCardProps) {
  const onKeyDown = (event: React.KeyboardEvent) => {
    // A menu inside the card closes itself on Escape and marks the event handled.
    if (event.defaultPrevented) return
    if (event.key === "Escape") {
      event.preventDefault()
      if (!busy) onEscape()
      return
    }
    if (event.key === "Enter" && onEnter && !handlesEnter(event.target)) {
      event.preventDefault()
      if (!busy) onEnter()
    }
  }

  const cardProps = {
    className: cn("wb-approve", queueSize > 1 && "is-stack", className),
    role: "alertdialog",
    "aria-labelledby": labelledBy,
    "aria-describedby": describedBy,
    "aria-busy": busy,
  } as const
  const body = (
    <>
      <div className={warn ? "kicker is-warn" : "kicker"}>
        <span
          id={kickerId}
          title={kickerTitle ?? (typeof kicker === "string" ? kicker : undefined)}
        >
          {kicker}
        </span>
        {queueSize > 1 ? <span className="count">{`1 / ${queueSize}`}</span> : null}
      </div>
      {children}
    </>
  )

  return (
    <div className="wb-approve-host" ref={hostRef} onKeyDown={onKeyDown}>
      {rest.as === "form" ? (
        <form {...cardProps} onSubmit={rest.onSubmit}>
          {body}
        </form>
      ) : (
        <div {...cardProps}>{body}</div>
      )}
      {aside}
    </div>
  )
}

interface InterruptConfirmProps {
  titleId: string
  title: React.ReactNode
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
  confirmLabel: string
  children?: React.ReactNode
}

/** The second step beside an interrupt, e.g. "Always allow this command?". */
function InterruptConfirm({
  titleId,
  title,
  busy = false,
  onCancel,
  onConfirm,
  confirmLabel,
  children,
}: InterruptConfirmProps) {
  return (
    <div className="wb-approve-confirm" role="dialog" aria-labelledby={titleId}>
      <h3 id={titleId}>{title}</h3>
      {children}
      <div className="wb-approve-confirm-actions">
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="danger" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}

export { InterruptCard, InterruptConfirm }
export type { InterruptCardProps }
