import React, { useId, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Sheet } from '../../../components/ui/sheet';
import type { Call } from './callService';
import { CallStage } from './CallStage';
import { DevicePickers } from './DevicePickers';
import { useElapsed } from './useElapsed';
import './calls.css';

/**
 * The current call at full size: who it is with, how long it has run, the tiles and the
 * controls. The chat comes back with **Back to chat**; the call goes on. A section, so it can
 * sit in the main area of the screen that shows it.
 */
export const CallView: React.FC<{ call: Call; names: Record<string, string>; onBack: () => void }> = ({
  call,
  names,
  onBack,
}) => {
  const elapsed = useElapsed(call.connectedAt) ?? '0:00';
  const titleId = useId();
  const [devices, setDevices] = useState(false);
  const [microphone, setMicrophone] = useState<string | null>(null);
  const [camera, setCamera] = useState<string | null>(null);
  const title = call.with ? (names[call.with] ?? 'Someone') : 'Call';
  const people = call.participants.length + 1;
  const waiting = call.dial === 'calling' && call.with ? { identity: call.with, name: title } : undefined;

  return (
    <section className="wb-callview" aria-labelledby={titleId}>
      <header className="wb-callview-head">
        <h2 id={titleId}>{title}</h2>
        <small>{`Call · ${people} ${people === 1 ? 'person' : 'people'} · ${elapsed} · nothing is recorded or kept`}</small>
      </header>
      <CallStage call={call} names={names} waiting={waiting} />
      <div className="wb-callview-controls">
        <Button variant={call.muted ? 'danger' : 'secondary'} onClick={() => call.mute(!call.muted)}>
          {call.muted ? 'Unmute' : 'Mute'}
        </Button>
        <Button variant="secondary" onClick={() => void call.setCamera(!call.camera)}>
          {call.camera ? 'Camera off' : 'Camera on'}
        </Button>
        <Button variant="secondary" onClick={() => setDevices(true)}>
          Devices
        </Button>
        <Button variant="secondary" onClick={onBack}>
          Back to chat
        </Button>
        <Button variant="danger" onClick={() => call.leave()}>
          Leave
        </Button>
      </div>
      {devices ? (
        <Sheet
          open
          onClose={() => setDevices(false)}
          titleId="call-devices-title"
          title="Devices"
          actions={
            <Button variant="secondary" onClick={() => setDevices(false)}>
              Done
            </Button>
          }
        >
          <DevicePickers
            microphone={microphone}
            camera={camera}
            onMicrophone={(id) => {
              setMicrophone(id || null);
              void call.setDevice('audio', id);
            }}
            onCamera={(id) => {
              setCamera(id || null);
              void call.setDevice('video', id);
            }}
          />
        </Sheet>
      ) : null}
    </section>
  );
};
