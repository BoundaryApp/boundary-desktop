/**
 * The result of an IPC call that reports failure in its value rather than by rejecting:
 * `success`, an `error` message when it failed, and whatever fields `T` adds. Main registers
 * these channels with `handleResult`, so a handler that throws still resolves to
 * `{ success: false, error }`.
 */
export type IpcResult<T extends object = object> = { success: boolean; error?: string } & T;
