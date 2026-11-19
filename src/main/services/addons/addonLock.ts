const BUSY_MESSAGE = 'An add-on install is already running.';

let busy = false;

/**
 * Runs `work` unless other add-on work is running: an install, undo, restart, Start, Turn off,
 * removal, workspace or budget change, or pending apply. Rejects at once otherwise.
 */
export async function runExclusive<T>(work: () => Promise<T>): Promise<T> {
  if (busy) throw new Error(BUSY_MESSAGE);
  busy = true;
  try {
    return await work();
  } finally {
    busy = false;
  }
}
