import type { CirclesState } from '../../../shared/types/circles';

/** People who offer the user a model, once each, in the order their Circles list them. */
export function offerProviders(circles: CirclesState): Map<string, string> {
  const found = new Map<string, string>();
  for (const circle of circles.snapshot.circles) {
    for (const offer of circle.offers) {
      if (!offer.isMine && !found.has(offer.identity)) found.set(offer.identity, offer.name);
    }
  }
  return found;
}
