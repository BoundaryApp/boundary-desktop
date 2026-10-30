import { powerSaveBlocker } from 'electron';
import { diag } from './circlesDiagnostics';

/**
 * Away mode (ADR 0034 §4): while a provider shares and has asked to stay reachable, keep the Mac
 * from sleeping so members can use the models. It only lasts while Boundary is open.
 */

let blockerId: number | null = null;

/** Start or stop the blocker; calling it again with the same answer does nothing. */
export function setAwayBlocker(on: boolean): void {
  if (on && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
    diag('main.away-blocker', { on: true, started: powerSaveBlocker.isStarted(blockerId) });
  } else if (!on && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
    diag('main.away-blocker', { on: false });
  }
}
