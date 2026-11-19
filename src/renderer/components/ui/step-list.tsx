import * as React from "react"

import { cn } from "../../lib/utils"

/** How a row's marker looks: not started, running, finished, failed, or needs the user. */
export type StepLook = "pending" | "run" | "done" | "fail" | "wait"

interface StepListRowProps {
  look: StepLook
  name: React.ReactNode
  detail?: React.ReactNode
  /** Right-hand status, e.g. "Done" or "1.2 of 3.4 GB". */
  right?: React.ReactNode
  /** Under the detail, e.g. a download bar. */
  children?: React.ReactNode
}

/**
 * One row of a long-running job's step list (add-on installs, project creates): a round
 * marker, the step's name and detail, and a status on the right. Goes in an `ol`.
 */
function StepListRow({ look, name, detail, right, children }: StepListRowProps) {
  return (
    <li
      className="grid grid-cols-[22px_1fr_auto] items-start gap-2.5 border-t border-line py-2.5"
      data-look={look}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-4 place-items-center rounded-full border text-2xs font-semibold",
          look === "done" && "border-ok bg-ok text-surface-1",
          look === "fail" && "border-danger bg-danger text-surface-1",
          look === "wait" && "border-warn bg-warn text-surface-1",
          look === "run" && "border-brand",
          look === "pending" && "border-line"
        )}
      >
        {look === "done" ? "✓" : look === "fail" ? "×" : look === "wait" ? "!" : ""}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={cn("text-ui", look === "pending" ? "text-fg-muted" : "font-medium text-fg")}>
          {name}
        </span>
        {detail ? <span className="text-xs text-fg-faint">{detail}</span> : null}
        {children}
      </div>
      <span className="text-xs tabular-nums text-fg-muted">{right}</span>
    </li>
  )
}

export { StepListRow }
