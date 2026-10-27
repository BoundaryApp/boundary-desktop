import { useCallback, useMemo, useRef, useState } from "react"

/** The message to show for a thrown value. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface SheetAction {
  busy: boolean
  error: string | null
  /** Shows a failure the action returned (`result.error ?? 'Could not …'`). */
  setError: (error: string | null) => void
  /**
   * Runs one sheet action: marks busy, clears the last error, and shows a thrown error.
   * Resolves to the action's result, or undefined when it threw.
   */
  run: <T>(action: () => Promise<T>) => Promise<T | undefined>
  /** The sheet's Cancel: closes and clears the error, unless an action is running. */
  dismiss: (close: () => void) => void
}

/** Busy and error state for a sheet whose owner runs its actions. */
export function useSheetAction(): SheetAction {
  const [busy, setBusyState] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const setBusy = useCallback((value: boolean) => {
    busyRef.current = value
    setBusyState(value)
  }, [])

  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(null)
    try {
      return await action()
    } catch (err) {
      setError(errorText(err))
      return undefined
    } finally {
      setBusy(false)
    }
  }, [setBusy])

  const dismiss = useCallback((close: () => void) => {
    if (busyRef.current) return
    close()
    setError(null)
  }, [])

  return useMemo(() => ({ busy, error, setError, run, dismiss }), [busy, error, run, dismiss])
}
