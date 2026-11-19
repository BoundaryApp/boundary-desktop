import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '../../components/ui/button';
import { CirclePlace } from '../chat/circle/CirclePlace';
import { JoiningPage } from '../chat/circle/JoiningPage';
import { StartJoinSheets, type StartJoinSheet } from '../chat/circle/StartJoinSheets';
import { CirclesMark } from '../chat/circle/CirclesMark';
import { requestOpenProject } from '../chat/projectOpenRequest';
import { CircleAreaHeader } from './CircleAreaHeader';
import { getCallService } from './calls/callService';
import { CallView } from './calls/CallView';
import { closeCallView, useCallViewOpen } from './calls/callViewState';
import { useCallService } from './calls/useCallService';
import type { CircleSnapshot } from '../../../shared/types/circles';
import { CirclesDock } from './CirclesDock';
import { CirclesRail } from './CirclesRail';
import {
  circleChannel,
  closeJoiningPage,
  forgetCircle,
  openCircle,
  openCircleAction,
  openDirect,
  showJoiningPage,
  useCirclesOpen,
} from './circlesNavigation';
import { useCircleChannels } from './useCircleChat';
import { useCirclesState } from './useCircles';
import { useDirectUnread } from './useDirectChat';
import '../chat/circle/circleChat.css';

/** The current call at full size, kept current as the call changes. */
const CallArea: React.FC<{ circles: CircleSnapshot[] }> = ({ circles }) => {
  const { call } = useCallService();
  const circleKey = call?.circleKey;
  const names = useMemo(() => {
    const members = circles.find((item) => item.key === circleKey)?.members ?? [];
    return Object.fromEntries(members.map((member) => [member.identity, member.name]));
  }, [circles, circleKey]);
  if (!call) return null;
  return (
    <main className="wb-center">
      <CallView
        call={call}
        names={names}
        onBack={() => {
          closeCallView();
          if (call.with) openDirect(call.circleKey, call.with);
        }}
      />
    </main>
  );
};

/** Whether this window is in a call; changes only when a call starts or ends. */
function useInCall(): boolean {
  const service = getCallService();
  return useSyncExternalStore(
    (listener) => service.onChange(listener),
    () => service.current !== null
  );
}

/**
 * The Circles destination (ADR 0052 §1–4): the list of every Circle, and beside it the open
 * Circle's channel or folder, the waiting page of a join, or what a Circle is when there are none.
 * It is the only way into a Circle. Nothing here changes a model setting.
 */
export const CirclesScreen: React.FC = () => {
  const circlesState = useCirclesState();
  const circles = useMemo(
    () => (circlesState.status === 'running' ? circlesState.snapshot.circles : []),
    [circlesState]
  );
  const keys = useMemo(() => circles.map((circle) => circle.key), [circles]);
  const channels = useCircleChannels(keys);
  const directUnread = useDirectUnread(keys);
  const openState = useCirclesOpen();
  const { open } = openState;
  const [startJoin, setStartJoin] = useState<StartJoinSheet | null>(null);

  // A new Circle can reach the state after `create` returns; open it once it's there.
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const created = createdKey !== null && circles.some((circle) => circle.key === createdKey);
  useEffect(() => {
    if (!created || !createdKey) return;
    openCircle(createdKey);
    setCreatedKey(null);
  }, [created, createdKey]);

  // A Circle this device left, or no longer has, is forgotten.
  const chosen = open?.kind === 'circle' ? (circles.find((circle) => circle.key === open.key) ?? null) : null;
  const missing = open?.kind === 'circle' && circlesState.status === 'running' && !chosen ? open.key : null;
  useEffect(() => {
    if (missing) forgetCircle(missing);
  }, [missing]);

  // A join waits in main. Once let in, someone on the waiting page moves into the Circle; once
  // cancelled or dismissed, the page closes. Someone who went elsewhere stays there.
  const join = circlesState.join ?? null;
  const admittedTo =
    circlesState.finishingJoin && circles.some((circle) => circle.key === circlesState.finishingJoin)
      ? circlesState.finishingJoin
      : null;
  const onJoiningPage = open?.kind === 'joining';
  // The page opens before main's join state arrives, so only a join seen here can be over.
  const sawJoin = useRef(false);
  if (onJoiningPage && (join || circlesState.finishingJoin)) sawJoin.current = true;
  const joinOver = onJoiningPage && sawJoin.current && !join && !circlesState.finishingJoin;
  if (!onJoiningPage) sawJoin.current = false;
  useEffect(() => {
    if (onJoiningPage && admittedTo) openCircle(admittedTo);
    else if (joinOver) closeJoiningPage();
  }, [onJoiningPage, admittedTo, joinOver]);

  const joiningShown = onJoiningPage && Boolean(join);
  // With nothing chosen, the first Circle by name opens, without being stored as a choice.
  const firstByName = useMemo(
    () => [...circles].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))[0] ?? null,
    [circles]
  );
  // A Circle that is gone counts as nothing chosen until it is forgotten, so the area never drops out.
  const shown = chosen ?? (joiningShown ? null : firstByName);

  const dock = (
    <CirclesDock
      circles={circles}
      channels={channels}
      directUnread={directUnread}
      openKey={joiningShown ? null : (shown?.key ?? null)}
      onOpenCircle={(key) => openCircle(key)}
      onCircleAction={openCircleAction}
      join={join}
      joiningOpen={joiningShown}
      onJoining={showJoiningPage}
      leaving={circlesState.status === 'running' ? circlesState.snapshot.leaving : undefined}
      onStart={() => setStartJoin('start')}
      onJoin={() => setStartJoin('join')}
      problem={circlesState.status === 'failed' ? (circlesState.error ?? 'Unknown error.') : null}
    />
  );

  // The call view takes the main area while it is open and there is a call to show.
  const inCall = useInCall();
  const callShown = useCallViewOpen() && inCall;

  // One rail serves every state, so the dock keeps its search and scroll across them. The open
  // Circle draws its area into the slot; the joining page has a header of its own.
  const [areaSlot, setAreaSlot] = useState<HTMLElement | null>(null);
  const area = callShown ? null : joiningShown ? (
    <CircleAreaHeader joining />
  ) : shown ? (
    <div ref={setAreaSlot} className="wb-circle-area-slot" />
  ) : null;

  return (
    <div className="relative flex h-full min-h-0 w-full">
      <CirclesRail area={area} dock={dock} />
      {callShown ? (
        <CallArea circles={circles} />
      ) : shown ? (
        <CirclePlace
          circle={shown}
          circles={circlesState}
          channels={channels[shown.key]}
          channelId={circleChannel(openState, shown.key)}
          onOpenChannel={(channelId) => openCircle(shown.key, channelId)}
          areaSlot={areaSlot}
          onOpenProject={requestOpenProject}
        />
      ) : joiningShown && join ? (
        <JoiningPage join={join} admitted={Boolean(circlesState.finishingJoin)} />
      ) : circlesState.status === 'starting' ? (
        <main className="wb-center" />
      ) : (
        <main className="wb-center">
          <div className="wb-circle-joining">
            <CirclesMark size={28} />
            <h2>Talk with the people you choose</h2>
            <p>
              A Circle is a small invite-only group. Members’ Macs connect to each other directly and keep its chat;
              there is no server in between.
            </p>
            <div className="wb-circles-welcome-actions">
              <Button type="button" onClick={() => setStartJoin('start')}>
                Start a Circle…
              </Button>
              <Button type="button" variant="secondary" onClick={() => setStartJoin('join')}>
                Join with an invite…
              </Button>
            </div>
          </div>
        </main>
      )}
      <StartJoinSheets
        sheet={startJoin}
        displayName={circlesState.displayName}
        joinWaiting={Boolean(join?.waiting || circlesState.finishingJoin)}
        onClose={() => setStartJoin(null)}
        onCreated={setCreatedKey}
        onJoining={showJoiningPage}
      />
    </div>
  );
};
