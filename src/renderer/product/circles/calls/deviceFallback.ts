/**
 * Whether a picked microphone or camera that failed to open should give way to the default one:
 * only when the picked device is gone, such as unplugged since it was chosen. A device that is
 * busy or refused stays failed, so the join sheet's preview and the call open the same device.
 */
export function fallsBackToDefault(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'OverconstrainedError' || name === 'NotFoundError';
}
