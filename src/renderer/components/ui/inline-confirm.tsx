import * as React from "react"

import { Button } from "./button"
import { useEscapeToClose } from "./use-dismiss"

/**
 * A confirm that opens in place under the row or card it acts on, for removing something without
 * a sheet. Cancel and Escape close it; neither works while `busy`. Pass `escapeDisabled` while a
 * sheet is open over it, so Escape closes the sheet instead.
 */
function InlineConfirm({
  label,
  confirmLabel,
  busy = false,
  error,
  escapeDisabled = false,
  onCancel,
  onConfirm,
  children,
}: {
  /** The dialog's accessible name, such as "Remove the GitHub login". */
  label: string
  /** The danger button's text. */
  confirmLabel: React.ReactNode
  busy?: boolean
  error?: React.ReactNode
  escapeDisabled?: boolean
  onCancel: () => void
  onConfirm: () => void
  /** What happens if they confirm. */
  children: React.ReactNode
}) {
  useEscapeToClose(onCancel, escapeDisabled, busy)
  return (
    <div className="wb-inline-confirm" role="alertdialog" aria-label={label}>
      <p>{children}</p>
      {error ? <p className="wb-sheet-error">{error}</p> : null}
      <div className="wb-inline-confirm-actions">
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="danger" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}

export { InlineConfirm }
