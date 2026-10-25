import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "../../lib/utils"

const HOVER_OPEN_MS = 400
const HOVER_CLOSE_MS = 150

interface InfoTipProps {
  /** What the tip explains; the button reads "About {label}". */
  label: string
  children: React.ReactNode
  className?: string
}

type OpenedBy = "hover" | "press" | null

// Reference text one step away (explainer-text study): a circled i after a label.
// Hover opens it after a short pause and closes it on leave; a click or Enter pins it
// until Esc or a click outside. Explanations never go in a native title tooltip.
function InfoTip({ label, children, className }: InfoTipProps) {
  const [openedBy, setOpenedBy] = React.useState<OpenedBy>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  React.useEffect(() => clearTimer, [])

  const hoverIn = () => {
    clearTimer()
    if (openedBy) return
    timer.current = setTimeout(() => setOpenedBy("hover"), HOVER_OPEN_MS)
  }
  const hoverOut = () => {
    clearTimer()
    if (openedBy !== "hover") return
    timer.current = setTimeout(() => setOpenedBy(null), HOVER_CLOSE_MS)
  }

  return (
    <PopoverPrimitive.Root
      open={openedBy !== null}
      onOpenChange={(open) => {
        clearTimer()
        if (!open) setOpenedBy(null)
      }}
    >
      <PopoverPrimitive.Trigger
        type="button"
        aria-label={`About ${label}`}
        className={cn("wb-infotip", className)}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
        onClick={(event) => {
          // Radix toggles on click; pin a hover-opened tip instead of closing it.
          event.preventDefault()
          clearTimer()
          setOpenedBy((was) => (was === "press" ? null : "press"))
        }}
      >
        i
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          role="note"
          aria-label={label}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="wb-infotip-pop"
          onPointerEnter={clearTimer}
          onPointerLeave={hoverOut}
          // A hover preview never takes focus; a pinned tip does, so it is read out.
          onOpenAutoFocus={(event) => {
            if (openedBy === "hover") event.preventDefault()
          }}
          tabIndex={-1}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

export { InfoTip }
