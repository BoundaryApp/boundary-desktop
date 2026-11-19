import React, { useEffect, useState } from 'react';
import type { CirclesResult } from '../../../../shared/types/circles';
import { Field } from '../../../components/ui/field';
import { CircleFormSheet } from './CircleFormSheet';

/** Which of the Circles list's sheets is open (ADR 0043 §7). */
export type StartJoinSheet = 'start' | 'join';

const api = () => window.electronAPI.circles;

/**
 * Start a Circle, or join one with a code, from the Circles list. Main needs the name other
 * members see before either, so a user without one gives it here. Start opens the new Circle;
 * join closes at once and the Circles destination shows the waiting page, since admission can take as
 * long as an admin takes to come online.
 */
export const StartJoinSheets: React.FC<{
  sheet: StartJoinSheet | null;
  /** The user's name in Circles; empty until they choose one. */
  displayName: string;
  /** A join is already waiting, so another can't start. */
  joinWaiting: boolean;
  onClose: () => void;
  onCreated: (key: string) => void;
  onJoining: () => void;
}> = ({ sheet, displayName, joinWaiting, onClose, onCreated, onJoining }) => {
  const [value, setValue] = useState('');
  const [myName, setMyName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValue('');
    setMyName('');
    setError(null);
  }, [sheet]);

  const needsName = !displayName;
  const starting = sheet === 'start';
  const blocked = !starting && joinWaiting;

  const run = async <T extends object>(call: () => Promise<CirclesResult<T>>): Promise<CirclesResult<T> | null> => {
    const result = await call();
    if (result.success === false) {
      setError(result.error);
      return null;
    }
    return result;
  };

  const submit = async () => {
    if (!sheet || busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      if (needsName && !(await run(() => api().setDisplayName({ name: myName })))) return;
      if (starting) {
        const result = await run(() => api().create({ name: value }));
        if (!result || result.success === false) return;
        onClose();
        onCreated(result.key);
        return;
      }
      // The join resolves when an admin lets this device in; main keeps its state meanwhile.
      void api().join({ code: value.trim() });
      onClose();
      onJoining();
    } finally {
      setBusy(false);
    }
  };

  return (
    <CircleFormSheet
      open={sheet !== null}
      onClose={onClose}
      busy={busy}
      titleId="circle-start-join"
      title={starting ? 'Start a Circle' : 'Join with an invite'}
      error={error}
      submitLabel={starting ? (busy ? 'Creating…' : 'Create') : 'Join'}
      canSubmit={!blocked && Boolean(value.trim()) && (!needsName || Boolean(myName.trim()))}
      onSubmit={() => void submit()}
    >
      <p className="wb-sheet-help">
        {starting
          ? 'You’ll be its admin and can invite people. It starts with a General channel.'
          : 'Paste the code someone sent you. An admin of that Circle has to be online to let you in.'}
      </p>
      {blocked ? <p className="wb-sheet-help">A join is already waiting. Cancel it from its row in the Circles list first.</p> : null}
      {needsName ? (
        <Field label="Your name in Circles" htmlFor="circle-my-name" hint="Members see it.">
          <input
            id="circle-my-name"
            value={myName}
            maxLength={80}
            autoFocus
            onChange={(event) => setMyName(event.target.value)}
          />
        </Field>
      ) : null}
      <Field label={starting ? 'Name' : 'Invite code'} htmlFor="circle-start-join-input">
        <input
          id="circle-start-join-input"
          className={starting ? undefined : 'mono'}
          value={value}
          maxLength={starting ? 80 : undefined}
          autoFocus={!needsName}
          disabled={blocked}
          placeholder={starting ? 'e.g. Book club' : 'e.g. yrb7ei1ng…'}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
    </CircleFormSheet>
  );
};
