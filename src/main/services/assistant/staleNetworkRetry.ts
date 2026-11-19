/**
 * Stopping the stack uses `compose stop`, so its containers outlive the run. If the project's
 * networks are later removed and recreated (`docker network prune`, an engine reset), those
 * containers still name the old network IDs, and `up` fails to start them with Docker's
 * "failed to set up container networking: network <id> not found". Recreating the containers
 * attaches them to the current networks; named volumes are kept.
 */
const STALE_NETWORK = /network [0-9a-f]{12,64} not found/i;

export function isStaleNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return STALE_NETWORK.test(message);
}

/**
 * Run `up` with `extraArgs` empty; if it fails on a stale network, run it once more with
 * `--force-recreate`. Any other failure, or a second failure, is thrown as it is.
 */
export async function upWithStaleNetworkRetry<T>(
  up: (extraArgs: string[]) => Promise<T>,
  onRetry?: (error: unknown) => void
): Promise<T> {
  try {
    return await up([]);
  } catch (error) {
    if (!isStaleNetworkError(error)) throw error;
    onRetry?.(error);
    return up(['--force-recreate']);
  }
}
