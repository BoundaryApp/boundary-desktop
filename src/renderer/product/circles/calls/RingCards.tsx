import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Ring } from '../../../../shared/calls/callRing';
import type { RingAction, RingAlert } from '../../../../shared/calls/ringAlert';
import { Avatar } from '../CircleControls';
import { openCallViewOnJoin } from './callViewState';
import { JoinCallSheet } from './JoinCallSheet';
import { LeaveCallSheet } from './LeaveCallSheet';
import { setRingSound } from './ringSound';
import { useCallNames, type CallNames } from './useCallNames';
import { useCallService } from './useCallService';
import { Button } from '../../../components/ui/button';
import './calls.css';

/**
 * A card for each call ringing for this user, on any screen, at the bottom right above the agent
 * button: who is calling and from which Circle, with **Decline** and **Join**. **Join** tells
 * the caller this user is coming and opens the join sheet; cancelling the sheet declines. The
 * sheet closes by itself if the ring ends first: the caller hung up, another device answered,
 * the Circle went or the caller stopped waiting. **Join** during a call asks before leaving it,
 * and joining opens the call view.
 *
 * Main hears about every ring, to alert while the window isn't in front: it sends back when to
 * play the ring sound, and **Answer** or **Decline** from a ring's notification, which act like
 * the card's buttons.
 */
export const RingCards: React.FC = () => {
  const { rings, answering: answered, service } = useCallService();
  const names = useCallNames();
  const [answeringRoom, setAnsweringRoom] = useState<string | null>(null);
  const answering = answered.find((ring) => ring.room === answeringRoom) ?? null;
  // The ring whose **Join** waits on leaving the current call; it closes if the ring ends first.
  const [leaveRoom, setLeaveRoom] = useState<string | null>(null);
  const leaveFor = rings.find((ring) => ring.room === leaveRoom) ?? null;
  const answer = (ring: Ring) => {
    service.answering(ring);
    setAnsweringRoom(ring.room);
  };
  const join = (ring: Ring) => {
    // A join still opening its devices counts as a call to leave.
    if (service.current || service.joining) setLeaveRoom(ring.room);
    else answer(ring);
  };

  useRingAlerts(rings, names);
  const act = useRef<(action: RingAction) => void>(() => undefined);
  act.current = ({ room, action }) => {
    const ring = rings.find((candidate) => candidate.room === room);
    if (!ring) return;
    if (action === 'answer') join(ring);
    else service.decline(ring);
  };
  useEffect(() => window.electronAPI.calls.onRingAction((action) => act.current(action)), []);

  return (
    <>
      {rings.length ? (
        <div className="wb-ring-cards">
          {rings.map((ring) => {
            const name = names.person(ring.circleKey, ring.from);
            return (
              <div key={ring.room} className="wb-ring-card" role="alertdialog" aria-label="Incoming call">
                <div className="wb-ring-card-who">
                  <Avatar name={name} seed={ring.from} />
                  <span className="wb-ring-card-copy">
                    <b>{`${name} is calling`}</b>
                    <small>{`${names.circle(ring.circleKey)} · just you two`}</small>
                  </span>
                </div>
                <div className="wb-ring-card-actions">
                  <Button variant="secondary" block type="button" onClick={() => service.decline(ring)}>
                    Decline
                  </Button>
                  <Button
                    variant="primary"
                    block
                    type="button"
                    onClick={() => join(ring)}
                  >
                    Join
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      <LeaveCallSheet
        open={leaveFor !== null}
        then="join"
        onLeave={() => {
          setLeaveRoom(null);
          if (leaveFor) answer(leaveFor);
        }}
        onCancel={() => setLeaveRoom(null)}
      />
      {answering ? (
        <JoinCallSheet
          title={`Call ${names.person(answering.circleKey, answering.from)}`}
          onJoin={(options) => {
            setAnsweringRoom(null);
            // A join that fails leaves no call, and the caller's ring ends on its own.
            openCallViewOnJoin(service.joinRing(answering, options));
          }}
          onCancel={() => {
            setAnsweringRoom(null);
            service.decline(answering);
          }}
        />
      ) : null}
    </>
  );
};

/** Tell main which calls are ringing, and play the ring sound while main says to. */
function useRingAlerts(rings: Ring[], names: CallNames): void {
  const alerts = useMemo<RingAlert[]>(
    () =>
      rings.map((ring) => ({
        room: ring.room,
        title: `${names.person(ring.circleKey, ring.from)} is calling`,
        body: `${names.circle(ring.circleKey)} · just you two`,
      })),
    [rings, names]
  );
  const sent = JSON.stringify(alerts);
  useEffect(() => {
    void window.electronAPI.calls.setRings(JSON.parse(sent) as RingAlert[]).catch((): undefined => undefined);
  }, [sent]);
  useEffect(() => {
    const stop = window.electronAPI.calls.onRingSound(setRingSound);
    return () => {
      stop();
      setRingSound(false);
    };
  }, []);
}
