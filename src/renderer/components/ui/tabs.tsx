import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "../../lib/utils"

import "./tabs.css"

/**
 * Tabs (ADR 0018 §5) on Radix Tabs: arrow keys, Home and End move between tabs and select the
 * one they land on, and the ids that tie a tab to its panel are generated. The look is tabs.css.
 */

const TabsSelect = React.createContext<{ value: string; onValueChange: (value: string) => void } | null>(null)

function Tabs({
  value,
  onValueChange,
  className,
  ...props
}: Omit<React.ComponentProps<typeof TabsPrimitive.Root>, "value" | "onValueChange" | "defaultValue"> & {
  value: string
  onValueChange: (value: string) => void
}) {
  const select = React.useMemo(() => ({ value, onValueChange }), [value, onValueChange])
  return (
    <TabsSelect.Provider value={select}>
      <TabsPrimitive.Root
        data-slot="tabs"
        value={value}
        onValueChange={onValueChange}
        className={cn(className)}
        {...props}
      />
    </TabsSelect.Provider>
  )
}

/**
 * `variant="bar"` is for tabs inside a header bar that draws its own bottom edge: the list
 * draws no rule and stretches to the bar's height, so the underline meets the bar's edge.
 */
function TabsList({
  variant = "default",
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & { variant?: "default" | "bar" }) {
  return <TabsPrimitive.List data-slot="tabs-list" data-variant={variant} className={cn(className)} {...props} />
}

/**
 * Radix selects on mousedown; a trigger also selects on click, so a click sent by assistive
 * technology (or a test) works. The current tab isn't selected again.
 */
function TabsTrigger({
  value,
  count,
  disabled,
  className,
  onClick,
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & { count?: number }) {
  const select = React.useContext(TabsSelect)
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      value={value}
      disabled={disabled}
      className={cn(className)}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || disabled || !select || select.value === value) return
        select.onValueChange(value)
      }}
      {...props}
    >
      {children}
      {count === undefined ? null : <span data-slot="tabs-count">{count}</span>}
    </TabsPrimitive.Trigger>
  )
}

/**
 * A panel holds focusable controls first, so it isn't a Tab stop of its own; pass `tabIndex`
 * to make it one. An inactive panel is rendered empty and hidden.
 */
function TabsContent({ className, tabIndex, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn(className)} {...props} tabIndex={tabIndex} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
