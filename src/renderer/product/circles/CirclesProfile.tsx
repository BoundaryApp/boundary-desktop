import React, { useState } from 'react';
import type { CirclesState } from '../../../shared/types/circles';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Sheet } from '../../components/ui/sheet';
import { CircleButton } from './CircleControls';
import { useAction, useCirclesState } from './useCircles';
import { APP_NAME } from '../../../shared/buildIdentity';

/**
 * The user's side of Circles: the name members see, joining from setup, and the profile in
 * Settings with the diagnostics file (ADR 0043 §10).
 */

const api = () => window.electronAPI.circles;

export function NameForm({ current, onSaved }: { current: string; onSaved?: () => void }) {
  const [name, setName] = useState(current);
  const action = useAction();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(() => api().setDisplayName({ name })).then((result) => {
          if (result?.success) onSaved?.();
        });
      }}
    >
      <label htmlFor="circles-name" className="text-ui text-fg">
        Your name in Circles
      </label>
      <div className="flex gap-2">
        <Input id="circles-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" variant="outline" disabled={action.busy || !name.trim()}>
          Save
        </Button>
      </div>
      <p className="text-xs text-fg-faint">Members of your Circles see this name. A new name reaches Circles you join after changing it.</p>
      {action.error ? <p className="text-xs text-danger">{action.error}</p> : null}
    </form>
  );
}

/** Joins and waits here, for setup. */
export function JoinForm({ onJoin }: { onJoin?: (code: string) => void }) {
  const [code, setCode] = useState('');
  const join = useAction();
  return (
    <form
      aria-label="Join a Circle"
      className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface-1 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (onJoin) {
          onJoin(code);
          return;
        }
        void join.run(() => api().join({ code })).then((result) => {
          if (result?.success) setCode('');
        });
      }}
    >
      <span className="text-title font-medium text-fg">Join with an invite</span>
      <span className="text-xs text-fg-faint">Paste the code someone sent you.</span>
      <Input className="h-[34px] bg-surface-0" aria-label="Invite code" placeholder="Invite code" value={code} onChange={(e) => setCode(e.target.value)} />
      <CircleButton type="submit" variant="outline" disabled={join.busy || !code.trim()}>
        {join.busy ? 'Joining…' : 'Join'}
      </CircleButton>
      {join.busy ? (
        <p className="text-xs text-fg-faint">
          This finishes on its own once one of the Circle&apos;s admins has {APP_NAME} open. Keep {APP_NAME} open.
        </p>
      ) : null}
      {join.error ? <p className="text-xs text-danger">{join.error}</p> : null}
    </form>
  );
}

const CONNECTION: Record<CirclesState['status'], string> = {
  stopped: 'Not connected',
  starting: 'Connecting',
  running: 'Connected',
  failed: 'Not connected',
};

function ProfileSheet({ circles, open, onClose }: { circles: CirclesState; open: boolean; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      titleId="circles-profile"
      title="Circles profile"
      error={error}
      actions={
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <NameForm current={circles.displayName} />
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() =>
            void api().revealDiagnostics().then((result) => {
              setError(result.success ? null : (result.error ?? 'Couldn’t show the file.'));
            })
          }
        >
          Show diagnostics file
        </Button>
      </div>
    </Sheet>
  );
}

/** Settings' Circles section: the user's name, the connection, and the profile sheet. */
export function CirclesProfileSection() {
  const circles = useCirclesState();
  const [open, setOpen] = useState(false);
  const problem = circles.status === 'failed' ? circles.error : null;
  return (
    <section className="wb-settings-section" aria-labelledby="settings-circles" id="settings-circles-profile">
      <h2 id="settings-circles">Circles</h2>
      <div className="wb-settings-row">
        <div>
          <p className="wb-settings-label">Circles profile</p>
          <p className="wb-settings-hint">
            {circles.displayName ? `${circles.displayName} · ${CONNECTION[circles.status]}` : 'No name yet. Members see the name you choose.'}
          </p>
          {problem ? <p className="wb-settings-hint is-warn">{problem}</p> : null}
        </div>
        <button type="button" className="wb-inference-btn" onClick={() => setOpen(true)}>
          Profile…
        </button>
      </div>
      <ProfileSheet circles={circles} open={open} onClose={() => setOpen(false)} />
    </section>
  );
}
