import { EventEmitter } from 'node:events';

/**
 * Runs the real network entry (`../networkProcess`) under Node with a fake parent port standing
 * in for main, and with `process.exit` swapped out so the process's own exit doesn't end the test
 * worker. Messages the process posts collect in `posted`.
 */

export type Posted = Record<string, unknown>;

/** Under vitest's 5 s test timeout, so a missing message fails with this harness's error. */
const WAIT_MS = 4_000;

export function networkProcessHarness() {
  const posted: Posted[] = [];
  const postedEvents = new EventEmitter();
  const parentPort = Object.assign(new EventEmitter(), {
    postMessage: (m: Posted) => {
      posted.push(m);
      postedEvents.emit('posted', m);
    },
  });
  const realExit = process.exit;

  /** Sends `data` to the process as main would. */
  const send = (data: Record<string, unknown>) => parentPort.emit('message', { data });

  /**
   * Resolves with the first posted message that `matches`, at once if one already came. Throws
   * after `WAIT_MS` naming `what` it waited for.
   */
  const postedWhere = (what: string, matches: (m: Posted) => boolean) =>
    new Promise<Posted>((resolve, reject) => {
      const found = posted.find(matches);
      if (found) return resolve(found);
      const timer = setTimeout(() => {
        postedEvents.off('posted', onPosted);
        reject(new Error(`The network process posted no ${what} within ${WAIT_MS} ms.`));
      }, WAIT_MS);
      const onPosted = (m: Posted) => {
        if (!matches(m)) return;
        clearTimeout(timer);
        postedEvents.off('posted', onPosted);
        resolve(m);
      };
      postedEvents.on('posted', onPosted);
    });

  /** Resolves with the first posted message of one of `types`. */
  const postedType = (...types: string[]) =>
    postedWhere(`message of type ${types.join(' or ')}`, (m) => types.includes(m.type as string));

  /** Installs the fake parent port and exit, then loads the network entry. */
  async function load(): Promise<void> {
    (process as unknown as { parentPort: unknown }).parentPort = parentPort;
    (process as unknown as { exit: unknown }).exit = (): void => undefined;
    await import('../networkProcess');
  }

  /** Puts `process.exit` back after the tick on which the process exits following `stopped`. */
  async function restore(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    process.exit = realExit;
  }

  return { posted, send, postedWhere, postedType, load, restore };
}

