import React, { useState } from 'react';
import type { CircleJoinState } from '../../../../shared/types/circles';
import './circleChat.css';

const api = () => window.electronAPI.circles;

/**
 * The chat while a join waits for an admin (ADR 0043 §7, Circles screen spec decision 12): the
 * switcher alone in the rail and the waiting page beside it. The user can switch places; the join
 * keeps going in main, and the Circle replaces the switcher's Joining row when it's let in.
 */
export const JoiningPlace: React.FC<{
  join: CircleJoinState;
  /** Let in, and waiting for write access: nothing is left to cancel. */
  admitted: boolean;
  switcher: React.ReactNode;
}> = ({ join, admitted, switcher }) => {
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
    <>
      <aside className="wb-left wb-circle-rail" aria-label="Joining a Circle">
        <div className="wb-titlebar-spacer" aria-hidden="true" />
        {switcher}
      </aside>
      <main className="wb-center">
        <div className="wb-circle-joining" role="status">
          <h2>{failed ? 'The invite didn’t work' : 'Waiting for an admin to let you in'}</h2>
          {failed ? (
            <p className="wb-circle-joining-error">{join.error}</p>
          ) : (
            <p>
              An admin of the Circle needs to be online. You can switch places; the join keeps going and the Circle
              appears in the switcher.
            </p>
          )}
          {admitted ? null : (
            <button type="button" className="wb-btn-tiny" disabled={busy} onClick={() => void cancel()}>
              {failed ? 'Close' : 'Cancel'}
            </button>
          )}
          {error ? <p className="wb-circle-joining-error">{error}</p> : null}
        </div>
      </main>
    </>
  );
};
