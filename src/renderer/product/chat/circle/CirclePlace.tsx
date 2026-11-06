import React, { useCallback, useState } from 'react';
import type { CircleChannel, CircleSnapshot, CirclesState } from '../../../../shared/types/circles';
import { Avatar } from '../../circles/CircleControls';
import { CircleConfirmSheet, type CircleConfirm } from '../../circles/CircleConfirmSheet';
import { InviteSheet, useInviteHints } from '../../circles/InviteSheet';
import { useCallCheck } from '../../circles/useCallCheck';
import { useCircleChat } from '../../circles/useCircleChat';
import { CallCheckSheet } from './CallCheckSheet';
import { ChannelSheets, type ChannelSheet } from './ChannelSheets';
import { CircleThread } from './CircleThread';
import { CirclesMark } from './CirclesMark';
import { CircleTab, OnlineDot, peopleInOrder } from './CircleTab';
import './circleChat.css';

/** General exists before the channels have been read. */
const GENERAL: CircleChannel = { id: 'general', name: 'General', unread: 0 };

function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M10 2.5v11" />
    </svg>
  );
}

/** A rail section's + button. */
const SectionAdd: React.FC<{ label: string; disabled?: boolean; onClick: () => void }> = ({ label, disabled, onClick }) => (
  <button type="button" className="wb-sect-add" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2.75v8.5M2.75 7h8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  </button>
);

export interface CirclePlaceProps {
  circle: CircleSnapshot;
  /** All of Circles' state, for invite names. */
  circles: CirclesState;
  /** The Circle's channels with unread counts; General alone until they are read. */
  channels: CircleChannel[] | undefined;
  channelId: string;
  onOpenChannel: (channelId: string) => void;
  /** The place switcher, at the top of the rail. */
  switcher: React.ReactNode;
}

/**
 * The chat screen in a Circle place (ADR 0042 §10): the Circle's rail, the open channel and the
 * Circle tab. Nothing from This Mac shows here.
 */
export const CirclePlace: React.FC<CirclePlaceProps> = ({
  circle,
  circles,
  channels: read,
  channelId,
  onOpenChannel,
  switcher,
}) => {
  const channels = read?.length ? read : [GENERAL];
  const channel = channels.find((item) => item.id === channelId) ?? channels[0];
  const chat = useCircleChat(circle.key, channel.id);
  // Closed until asked for, as in the study; choosing a person opens it.
  const [inspector, setInspector] = useState(false);
  const [person, setPerson] = useState<string | null>(null);
  const [channelSheet, setChannelSheet] = useState<ChannelSheet | null>(null);
  const callCheck = useCallCheck();
  const [callCheckOpen, setCallCheckOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<CircleConfirm | null>(null);
  const hints = useInviteHints(circle.myRole === 'admin' ? circle.key : undefined, circles.inviteCodeIds);
  // Choosing a person, from the rail, the tab or a who-line, opens the inspector at them.
  const showPerson = useCallback((identity: string): void => {
    setInspector(true);
    setPerson(identity);
  }, []);
  // Inviting from the rail opens the inspector too, where invites are managed (ADR 0043).
  const invite = (): void => {
    setInspector(true);
    setPerson(null);
    setInviting(true);
  };

  return (
    <>
      <aside className="wb-left wb-circle-rail" aria-label={`${circle.name} chats`}>
        <div className="wb-titlebar-spacer" aria-hidden="true" />
        {switcher}
        <div className="wb-nav-scroll">
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            <div className="wb-sect">
              <span className="wb-sect-name">Channels</span>
              {circle.myRole === 'admin' ? (
                <SectionAdd label="Add a channel" onClick={() => setChannelSheet({ kind: 'add' })} />
              ) : null}
            </div>
            {channels.map((item) => {
              // The open channel is being read, so its count isn't shown.
              const unread = item.id === channel.id ? 0 : item.unread;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`wb-row has-mark${item.id === channel.id ? ' is-on' : ''}`}
                  aria-current={item.id === channel.id ? 'page' : undefined}
                  aria-label={unread ? `${item.name}, ${unread} unread` : item.name}
                  onClick={() => onOpenChannel(item.id)}
                >
                  <CirclesMark size={14} />
                  <span className="wb-row-title">{item.name}</span>
                  {unread ? <span className="wb-rail-count">{unread}</span> : null}
                </button>
              );
            })}
            <div className="wb-sect">
              <span className="wb-sect-name">People</span>
              {circle.myRole === 'admin' ? (
                <SectionAdd label="Invite someone" disabled={!circle.writable} onClick={invite} />
              ) : null}
            </div>
            {peopleInOrder(circle).map((member) => (
              <button
                key={member.identity}
                type="button"
                className="wb-row has-mark"
                title={member.isMe ? 'Your details' : `${member.name}’s details`}
                onClick={() => showPerson(member.identity)}
              >
                <Avatar name={member.name} seed={member.identity} />
                <span className="wb-row-title">
                  {member.isMe ? 'You' : member.name}
                  {member.role === 'admin' ? <small className="wb-circle-admin"> admin</small> : null}
                </span>
                <OnlineDot online={member.online} />
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="wb-center">
        <CircleThread
          circle={circle}
          channel={channel}
          chat={chat}
          onPerson={showPerson}
          headerEnd={
            <button
              type="button"
              className="wb-act wb-circle-panel-btn"
              aria-label={inspector ? 'Close Circle details' : 'Open Circle details'}
              aria-pressed={inspector}
              title="Circle details"
              onClick={() => setInspector((was) => !was)}
            >
              <PanelIcon />
            </button>
          }
        />
      </main>

      {inspector ? (
        <CircleTab
          circle={circle}
          circles={circles}
          channels={channels}
          hints={hints}
          person={person}
          onPerson={setPerson}
          onClose={() => setInspector(false)}
          onInvite={() => setInviting(true)}
          onConfirm={setConfirm}
          onChannelSheet={setChannelSheet}
          onCallCheck={callCheck ? () => setCallCheckOpen(true) : undefined}
        />
      ) : null}

      {callCheck ? (
        <CallCheckSheet check={callCheck} circle={circle} open={callCheckOpen} onClose={() => setCallCheckOpen(false)} />
      ) : null}

      {circle.myRole === 'admin' ? (
        <InviteSheet
          key={`invite-${circle.key}`}
          circle={circle}
          circles={circles}
          hints={hints}
          open={inviting}
          onClose={() => setInviting(false)}
        />
      ) : null}
      <CircleConfirmSheet
        key={`confirm-${circle.key}`}
        circle={circle}
        pending={confirm}
        onClose={() => setConfirm(null)}
      />

      <ChannelSheets
        circleKey={circle.key}
        circleName={circle.name}
        sheet={channelSheet}
        onClose={() => setChannelSheet(null)}
        onAdded={onOpenChannel}
      />
    </>
  );
};
