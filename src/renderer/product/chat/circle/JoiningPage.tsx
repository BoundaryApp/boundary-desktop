import React, { useState } from 'react';
import type { CircleJoinState } from '../../../../shared/types/circles';
import { Button } from '../../../components/ui/button';
import './circleChat.css';

const api = () => window.electronAPI.circles;

/**
 * The page beside the Circles list while a join waits for an admin (ADR 0043 §7, Circles screen
 * spec decision 12). The user can go elsewhere; the join keeps going in main, and the Circle
 * replaces the list's Joining row when it's let in.
 */
export const JoiningPage: React.FC<{
  join: CircleJoinState;
  /** Let in, and waiting for write access: nothing is left to cancel. */
  admitted: boolean;
}> = ({ join, admitted }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = Boolean(join.error);
  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api().cancelJoin();
      if (result.success === false) setError(result.error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="wb-center">
        <div className="wb-circle-joining" role="status">
          <h2>{failed ? 'The invite didn’t work' : 'Waiting for an admin to let you in'}</h2>
          {failed ? (
            <p className="wb-circle-joining-error">{join.error}</p>
          ) : (
            <p>
              An admin of the Circle needs to be online. You can leave this page; the join keeps going and the Circle
              appears in the list.
            </p>
          )}
          {admitted ? null : (
            <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={() => void cancel()}>
              {failed ? 'Close' : 'Cancel'}
            </Button>
          )}
          {error ? <p className="wb-circle-joining-error">{error}</p> : null}
        </div>
    </main>
  );
};
