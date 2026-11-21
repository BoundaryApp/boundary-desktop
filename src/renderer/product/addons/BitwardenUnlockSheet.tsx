import React, { useState } from 'react';
import { Callout } from '../../components/ui/alert';
import { Input } from '../../components/ui/input';
import { Field } from '../../components/ui/field';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { useSheetAction } from '../../components/ui/use-sheet-action';
import { isActualFailure } from '../../../shared/types/addons';
import { unlockErrorText } from './useBitwarden';

// Unlock (spec decision 29): a masked field whose value main writes to `vault.sh unlock`'s stdin.
// One try per press, as the stack makes one attempt; a wrong password leaves the account locked.
// Closing the sheet unmounts the form, which drops the password.

const UnlockForm: React.FC<{ slug: string; onClose(): void }> = ({ slug, onClose }) => {
  const [password, setPassword] = useState('');
  const { busy, error, setError, run } = useSheetAction();

  const unlock = () =>
    run(async () => {
      const reply = await window.electronAPI.addons.bitwarden.unlock(slug, password);
      if (!reply.success) setError(reply.error ?? 'Boundary’s add-on service didn’t answer.');
      else if (isActualFailure(reply.result)) {
        setError(unlockErrorText(reply.result.error));
        setPassword('');
      } else onClose();
    });

  return (
    <Sheet
      open
      onClose={onClose}
      busy={busy}
      titleId="bitwarden-unlock-title"
      title={`Unlock ${slug}`}
      actions={
        <SheetConfirmActions
          busy={busy}
          onCancel={onClose}
          confirmLabel={busy ? 'Unlocking…' : 'Unlock'}
          confirmDisabled={busy || password === ''}
          onConfirm={() => void unlock()}
        />
      }
    >
      <p className="wb-sheet-lede">
        Boundary passes the master password to the agent stack once and keeps nothing. The account stays unlocked until the
        assistant restarts or you lock it.
      </p>
      <Field label="Master password" htmlFor="bitwarden-unlock-password">
        <Input
          id="bitwarden-unlock-password"
          type="password"
          value={password}
          disabled={busy}
          autoComplete="off"
          autoFocus
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && password && !busy) void unlock();
          }}
        />
      </Field>
      {error ? <Callout variant="destructive">{error}</Callout> : null}
    </Sheet>
  );
};

/** Mounts the form only while an account is chosen. */
export const BitwardenUnlockSheet: React.FC<{ slug: string | null; onClose(): void }> = ({ slug, onClose }) =>
  slug ? <UnlockForm key={slug} slug={slug} onClose={onClose} /> : null;
