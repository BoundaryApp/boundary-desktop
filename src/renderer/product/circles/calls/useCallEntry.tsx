import React, { useState } from 'react';
import { getCallService, type Call, type CallService, type JoinOptions } from './callService';
import { openCallViewOnJoin } from './callViewState';
import { JoinCallSheet } from './JoinCallSheet';
import { LeaveCallSheet } from './LeaveCallSheet';

/**
 * Whether **Call** or **Join** would replace a call: one that is on, or a join still opening its
 * devices. The service has already left the old call while a join opens, so `current` alone
 * misses that moment.
 */
export function inCallOrJoining(service: Pick<CallService, 'current' | 'joining'>): boolean {
  return service.current !== null || service.joining;
}

export interface CallEntryOptions<T> {
  /** What the leave sheet's confirm says comes next: **Leave and call** or **Leave and join**. */
  then: 'call' | 'join';
  title: (target: T) => string;
  /** Starts the call; the call view opens if it succeeds. */
  join: (target: T, options: JoinOptions) => Promise<Call>;
  /** Runs as the join sheet opens. */
  onAsk?: (target: T) => void;
  /** Runs when the join sheet is cancelled. */
  onCancel?: (target: T) => void;
  /**
   * The current version of a target, or null once it is gone; a gone target closes its sheet.
   * Without these, a sheet stays open until it is answered.
   */
  liveForLeave?: (target: T) => T | null;
  liveForJoin?: (target: T) => T | null;
}

/**
 * Entering a call from a **Call** or **Join** button. During a call, or while another join is
 * opening, it asks before leaving; then it shows the join sheet, and joining opens the call view.
 * `enter` is the button's handler and `sheets` renders both sheets.
 */
export function useCallEntry<T>(options: CallEntryOptions<T>): { enter: (target: T) => void; sheets: React.ReactElement } {
  const { then, title, join, onAsk, onCancel, liveForLeave, liveForJoin } = options;
  const [leaving, setLeaving] = useState<T | null>(null);
  const [asking, setAsking] = useState<T | null>(null);
  const leaveFor = leaving !== null && liveForLeave ? liveForLeave(leaving) : leaving;
  const joinFor = asking !== null && liveForJoin ? liveForJoin(asking) : asking;

  const ask = (target: T) => {
    onAsk?.(target);
    setAsking(target);
  };
  const enter = (target: T) => {
    if (inCallOrJoining(getCallService())) setLeaving(target);
    else ask(target);
  };

  const sheets = (
    <>
      <LeaveCallSheet
        open={leaveFor !== null}
        then={then}
        onLeave={() => {
          setLeaving(null);
          if (leaveFor !== null) ask(leaveFor);
        }}
        onCancel={() => setLeaving(null)}
      />
      {joinFor !== null ? (
        <JoinCallSheet
          title={title(joinFor)}
          onJoin={(joinOptions) => {
            setAsking(null);
            // A join that fails leaves no call and nothing to show.
            openCallViewOnJoin(join(joinFor, joinOptions));
          }}
          onCancel={() => {
            setAsking(null);
            onCancel?.(joinFor);
          }}
        />
      ) : null}
    </>
  );
  return { enter, sheets };
}
