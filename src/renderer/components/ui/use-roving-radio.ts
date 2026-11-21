import * as React from "react"

/**
 * Keyboard for a set of radio-like buttons (Segmented, a single ChipGroup): one Tab stop, and
 * arrow keys that select and focus the next enabled item (ADR 0066). The Tab stop is the
 * selected item, or the first enabled one when nothing is selected or the selected one is
 * disabled. Arrow Right/Down and Left/Up wrap; Home and End pick the first and last enabled.
 */
function useRovingRadio<T extends string>({
  values,
  value,
  isDisabled,
  onChange,
}: {
  values: T[]
  value: T | null
  isDisabled?: (value: T) => boolean
  onChange: (value: T) => void
}) {
  const elements = React.useRef(new Map<T, HTMLElement>())
  const disabled = (v: T) => isDisabled?.(v) ?? false
  const enabled = values.filter((v) => !disabled(v))
  const tabStop = value !== null && enabled.includes(value) ? value : (enabled[0] ?? null)

  const itemProps = (v: T) => ({
    ref: (el: HTMLElement | null) => {
      if (el) elements.current.set(v, el)
      else elements.current.delete(v)
    },
    tabIndex: v === tabStop ? 0 : -1,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (enabled.length === 0) return
      const at = enabled.indexOf(v)
      let target: T | undefined
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          target = enabled[(at + 1) % enabled.length]
          break
        case "ArrowLeft":
        case "ArrowUp":
          target = enabled[(at - 1 + enabled.length) % enabled.length]
          break
        case "Home":
          target = enabled[0]
          break
        case "End":
          target = enabled[enabled.length - 1]
          break
        default:
          return
      }
      event.preventDefault()
      if (target !== value) onChange(target)
      elements.current.get(target)?.focus()
    },
  })

  return { itemProps }
}

export { useRovingRadio }
