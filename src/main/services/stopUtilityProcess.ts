import type { UtilityProcess } from 'electron';

/**
 * Ask a utilityProcess to stop with `sendStop`, and wait for it to exit. One that hasn't exited
 * after `timeoutMs` is killed.
 */
export function stopUtilityProcess(proc: UtilityProcess, sendStop: () => void, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill();
      resolve();
    }, timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    sendStop();
  });
}
