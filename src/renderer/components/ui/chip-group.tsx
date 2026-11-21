import * as React from "react"

import { cn } from "../../lib/utils"
import { useRovingRadio } from "./use-roving-radio"

import "./toggle.css"

interface ChipItem {
  value: string
  disabled: boolean
  element: HTMLElement
}

type ChipGroupContext =
  | { type: "multiple" }
  | {
      type: "single"
      value: string
      onValueChange: (value: string) => void
      register: (item: ChipItem) => () => void
      itemProps: (value: string) => ReturnType<ReturnType<typeof useRovingRadio<string>>["itemProps"]>
    }

const MULTIPLE: ChipGroupContext = { type: "multiple" }

const ChipGroupContext = React.createContext<ChipGroupContext | null>(null)

function useChipGroup() {
  return React.useContext(ChipGroupContext)
}

type ChipGroupProps = { className?: string; children: React.ReactNode; "aria-label": string } & (
  | { type: "single"; value: string; onValueChange: (value: string) => void }
  | { type: "multiple" }
)

/**
 * A wrapping row of Chips (ADR 0066). `single` is a radio group: one chip is on, one Tab stop,
 * arrow keys move it. `multiple` is a plain group of toggle chips, each its own Tab stop.
 */
function ChipGroup(props: ChipGroupProps) {
  const { className, children } = props
  return props.type === "single" ? (
    <SingleChipGroup {...props}>{children}</SingleChipGroup>
  ) : (
    <ChipGroupContext.Provider value={MULTIPLE}>
      <div role="group" aria-label={props["aria-label"]} data-slot="chip-group" className={cn(className)}>
        {children}
      </div>
    </ChipGroupContext.Provider>
  )
}

function SingleChipGroup({
  value,
  onValueChange,
  className,
  children,
  ...props
}: Extract<ChipGroupProps, { type: "single" }>) {
  const [items, setItems] = React.useState<ChipItem[]>([])
  const register = React.useCallback((item: ChipItem) => {
    setItems((current) =>
      [...current.filter((other) => other.value !== item.value), item].sort((a, b) =>
        a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      )
    )
    return () => setItems((current) => current.filter((other) => other.element !== item.element))
  }, [])
  const { itemProps } = useRovingRadio({
    values: items.map((item) => item.value),
    value,
    isDisabled: (v) => items.find((item) => item.value === v)?.disabled === true,
    onChange: onValueChange,
  })
  const context = React.useMemo<ChipGroupContext>(
    () => ({ type: "single", value, onValueChange, register, itemProps }),
    // itemProps closes over items and value, so it changes with them.
    [value, onValueChange, register, items]
  )
  return (
    <ChipGroupContext.Provider value={context}>
      <div role="radiogroup" aria-label={props["aria-label"]} data-slot="chip-group" className={cn(className)}>
        {children}
      </div>
    </ChipGroupContext.Provider>
  )
}

export { ChipGroup, useChipGroup }
export type { ChipItem }
