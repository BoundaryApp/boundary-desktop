import { persistDebugLog } from '../../persistDebugLog';

/** Why the `hermes` container was started, restarted or recreated (or its network namespace lost). */
export type HermesReplacedReason = 'start' | 'settings-restart' | 'web-search' | 'project-mounts' | 'addon-reload' | 'broker-down';

type HermesReplacedListener = (reason: HermesReplacedReason) => void | Promise<void>;
type BeforeStackUpListener = () => Promise<void>;

const replacedListeners = new Set<HermesReplacedListener>();
const beforeUpListeners = new Set<BeforeStackUpListener>();

/** Runs `listener` after a successful hermes start, restart or recreate. Returns an unsubscribe function. */
export function onHermesReplaced(listener: HermesReplacedListener): () => void {
  const entry: HermesReplacedListener = (reason) => listener(reason);
  replacedListeners.add(entry);
  return () => void replacedListeners.delete(entry);
}

/**
 * Tells the listeners hermes was started, restarted or recreated. Returns without waiting for
 * them; a listener that throws or rejects is logged (reason and error name only) and ignored.
 */
export function notifyHermesReplaced(reason: HermesReplacedReason): void {
  for (const listener of [...replacedListeners]) {
    const failed = (error: unknown) =>
      persistDebugLog('assistant-stack', 'hermes-replaced listener failed', {
        reason,
        error: error instanceof Error ? error.name : typeof error,
      });
    try {
      void Promise.resolve(listener(reason)).catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}

/** Runs `listener` before the stack's `up` in a start. Returns an unsubscribe function. */
export function onBeforeStackUp(listener: BeforeStackUpListener): () => void {
  beforeUpListeners.add(listener);
  return () => void beforeUpListeners.delete(listener);
}

/** Awaits the before-`up` listeners in registration order. The first rejection propagates. */
export async function runBeforeStackUp(): Promise<void> {
  for (const listener of [...beforeUpListeners]) await listener();
}
