import { powerSaveBlocker } from 'electron';
import { diag } from './circlesDiagnostics';

/**
 * Away mode (ADR 0034 §4): while a provider shares and has asked to stay reachable, keep the Mac
 * from sleeping so members can use the models. It only lasts while Boundary is open.
 */

let blockerId: number | null = null;
/** What wants the Mac awake: shared models (ADR 0034 §4) and shared services (ADR 0048 §8). */
const reasons = new Set<AwayReason>();

export type AwayReason = 'models' | 'services';

/** Start or stop the blocker for one reason; it runs while any reason wants it. */
export function setAwayBlocker(on: boolean, reason: AwayReason = 'models'): void {
  if (on) reasons.add(reason);
  else reasons.delete(reason);
  const want = reasons.size > 0;
  if (want && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
    diag('main.away-blocker', { on: true, reason, started: powerSaveBlocker.isStarted(blockerId) });
  } else if (!want && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
    diag('main.away-blocker', { on: false, reason });
  }
}
