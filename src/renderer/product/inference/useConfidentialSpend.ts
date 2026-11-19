import { useEffect, useState } from 'react';
import type { ConfidentialSpend } from '../../../shared/types/confidentialState';

/**
 * The confidential pool's spend over the last 30 days. Fetches each time `open` turns true; main
 * pushes no updates, so a turn that ends while it is open shows next time. `spend` is null while
 * closed, until main answers, and when it has pools off.
 */
export function useConfidentialSpend(open: boolean): {
  spend: ConfidentialSpend | null;
  loading: boolean;
} {
  const [spend, setSpend] = useState<ConfidentialSpend | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) {
      // Closed: drop the last numbers so the next open doesn't show them while it fetches.
      setSpend(null);
      return;
    }
    let current = true;
    setLoading(true);
    window.electronAPI.confidential
      .getSpend()
      .then((next): void => {
        if (current) setSpend(next);
      })
      .catch((): void => undefined)
      .finally((): void => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [open]);
  return { spend, loading };
}
