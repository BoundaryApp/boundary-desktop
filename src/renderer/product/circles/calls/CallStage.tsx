import React, { useEffect, useRef, useState } from 'react';
import type { CallParticipant } from '../../../../shared/calls/callSession';
import { Button } from '../../../components/ui/button';
import { Avatar } from '../CircleControls';
import { watchLevel } from './audioLevel';
import type { Call } from './callService';
import './callStage.css';

/** Plays a stream into a media element; React can't set `srcObject` as a prop. */
function useStream<T extends HTMLMediaElement>(stream: MediaStream | null) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return ref;
}

/** A level over this rings a tile. */
const SPEAKING_LEVEL = 0.05;

/** Whether the stream's audio is loud enough to count as speaking. */
function useSpeaking(stream: MediaStream | null): boolean {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!stream) return;
    const stop = watchLevel(stream, (level) => setSpeaking(level > SPEAKING_LEVEL));
    return () => {
      stop();
      setSpeaking(false);
    };
  }, [stream]);
  return speaking;
}

function StreamVideo({ stream, mirrored }: { stream: MediaStream | null; mirrored?: boolean }) {
  const ref = useStream<HTMLVideoElement>(stream);
  return <video ref={ref} className={`wb-call-video${mirrored ? ' is-mirrored' : ''}`} autoPlay playsInline muted />;
}

function StreamAudio({ stream }: { stream: MediaStream | null }) {
  const ref = useStream<HTMLAudioElement>(stream);
  return <audio ref={ref} autoPlay />;
}

function Tile({
  label,
  name,
  seed,
  stream,
  camera,
  muted,
  mirrored,
  children,
}: {
  label: string;
  name: string;
  seed: string;
  stream: MediaStream | null;
  camera: boolean;
  muted: boolean;
  mirrored?: boolean;
  children?: React.ReactNode;
}) {
  const speaking = useSpeaking(stream);
  return (
    <li className={`wb-call-tile${speaking ? ' is-speaking' : ''}`} aria-label={label}>
      {camera && stream ? <StreamVideo stream={stream} mirrored={mirrored} /> : <Avatar name={name} seed={seed} large />}
      <span className="wb-call-name">
        {label}
        {muted ? <span className="wb-call-muted">Muted</span> : null}
      </span>
      {children}
    </li>
  );
}

function Remote({ call, person, names }: { call: Call; person: CallParticipant; names: Record<string, string> }) {
  const name = names[person.identity] ?? 'Someone';
  const stream = person.remote instanceof MediaStream ? person.remote : null;
  if (person.state === 'unreachable') {
    return (
      <Tile label={name} name={name} seed={person.identity} stream={null} camera={false} muted={false}>
        <span className="wb-call-note">Can't reach {name} from here</span>
        <Button variant="secondary" size="sm" onClick={() => call.retry(person.key)}>
          Try again
        </Button>
      </Tile>
    );
  }
  return (
    <Tile label={name} name={name} seed={person.identity} stream={stream} camera={person.camera} muted={person.muted}>
      {person.state === 'connecting' ? <span className="wb-call-note">Connecting…</span> : null}
      <StreamAudio stream={stream} />
    </Tile>
  );
}

/**
 * Tiles for a call, from props alone (Circle calls spec decision 8 and "The public seam"): this
 * Mac first, then each person, with video when their camera is on and their face otherwise.
 */
export const CallStage: React.FC<{
  call: Call;
  names: Record<string, string>;
  /** A person being rung who hasn't come yet. */
  waiting?: { identity: string; name: string };
}> = ({ call, names, waiting }) => (
  <ul className="wb-call-stage" aria-label="Call">
    <Tile
      label="You"
      name={names[call.me] ?? 'You'}
      seed={call.me}
      stream={call.localStream}
      camera={call.camera}
      muted={call.muted}
      mirrored
    />
    {call.participants.map((person) => (
      <Remote key={person.key} call={call} person={person} names={names} />
    ))}
    {waiting && call.participants.length === 0 ? (
      <Tile label={waiting.name} name={waiting.name} seed={waiting.identity} stream={null} camera={false} muted={false}>
        <span className="wb-call-note">Calling {waiting.name}…</span>
      </Tile>
    ) : null}
  </ul>
);
