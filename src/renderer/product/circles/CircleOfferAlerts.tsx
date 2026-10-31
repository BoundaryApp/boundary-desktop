import React, { useEffect, useRef, useState } from 'react';
import type { CircleOfferView, CirclesState } from '../../../shared/types/circles';
import { openCircles } from './circlesNavigation';
import { alertsFor, diffOffers, type OfferAlert, type OfferChange } from './offerAlerts';
import { useCirclesState } from './useCircles';

/** A change must hold this long to count, so a brief network drop stays silent. */
export const OFFER_SETTLE_MS = 10_000;
/**
 * How long a Circle's offers are taken as found once it is first seen. Every provider reads
 * offline until the swarm reconnects, and a new member's offers arrive as the Circle replicates.
 */
export const OFFER_QUIET_MS = 30_000;
export const OFFER_ALERT_MS = 8_000;
const MAX_ALERTS = 3;

interface SettledCircle {
  offers: CircleOfferView[];
  quietUntil: number;
}

/** Calls `onChanges` with each settled change to other members' offers. */
function useOfferChanges(state: CirclesState, onChanges: (changes: OfferChange[]) => void): void {
  const settled = useRef(new Map<string, SettledCircle>());
  const pending = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const latest = useRef<Map<string, CircleOfferView[]>>(new Map());
  const notify = useRef(onChanges);
  notify.current = onChanges;

  const cancel = () => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
  };

  useEffect(() => {
    if (state.status !== 'running') {
      cancel();
      settled.current.clear();
      return;
    }
    const now = Date.now();
    const next = new Map<string, SettledCircle>();
    const moved = new Map<string, CircleOfferView[]>();
    const changes: OfferChange[] = [];
    for (const circle of state.snapshot.circles) {
      // No role yet means this device is still joining and has none of the Circle's view.
      if (circle.myRole === null) continue;
      const known = settled.current.get(circle.key);
      if (!known || now < known.quietUntil) {
        next.set(circle.key, { offers: circle.offers, quietUntil: known?.quietUntil ?? now + OFFER_QUIET_MS });
        continue;
      }
      const found = diffOffers(circle.name, known.offers, circle.offers);
      next.set(circle.key, found.length > 0 ? known : { ...known, offers: circle.offers });
      if (found.length > 0) moved.set(circle.key, circle.offers);
      changes.push(...found);
    }
    settled.current = next;
    latest.current = moved;

    if (changes.length === 0) return cancel();
    const key = JSON.stringify(changes);
    if (pending.current?.key === key) return;
    cancel();
    const timer = setTimeout(() => {
      pending.current = null;
      for (const [circle, offers] of latest.current) {
        const known = settled.current.get(circle);
        if (known) known.offers = offers;
      }
      notify.current(changes);
    }, OFFER_SETTLE_MS);
    pending.current = { key, timer };
  }, [state]);

  useEffect(() => cancel, []);
}

const AlertToast: React.FC<{ alert: OfferAlert; onDismiss: () => void }> = ({ alert, onDismiss }) => {
  useEffect(() => {
    const timer = setTimeout(onDismiss, OFFER_ALERT_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);
  return (
    <div className="wb-toast wb-circle-alert" role="status">
      <span>{alert.text}</span>
      <button
        type="button"
        onClick={() => {
          openCircles({ person: alert.provider });
          onDismiss();
        }}
      >
        Open Circles
      </button>
      <button type="button" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
};

/** Toasts, on every screen, for other members' shared models coming and going. */
export const CircleOfferAlerts: React.FC = () => {
  const circles = useCirclesState();
  const [alerts, setAlerts] = useState<(OfferAlert & { id: number; dismiss: () => void })[]>([]);
  const nextId = useRef(0);

  useOfferChanges(circles, (changes) => {
    const fresh = alertsFor(changes).map((alert) => {
      const id = nextId.current++;
      const dismiss = () => setAlerts((shown) => shown.filter((other) => other.id !== id));
      return { ...alert, id, dismiss };
    });
    setAlerts((shown) => [...shown, ...fresh].slice(-MAX_ALERTS));
  });

  if (alerts.length === 0) return null;
  return (
    <div className="wb-circle-alerts">
      {alerts.map((alert) => (
        <AlertToast key={alert.id} alert={alert} onDismiss={alert.dismiss} />
      ))}
    </div>
  );
};
