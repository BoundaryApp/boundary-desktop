import React, { useState } from 'react';
import type { CircleChannel, CircleMemberView, CircleSnapshot } from '../../../../shared/types/circles';
import { Avatar } from '../../circles/CircleControls';
import { useCallCheck } from '../../circles/useCallCheck';
import { useCircleChat } from '../../circles/useCircleChat';
import { CallCheckSheet } from './CallCheckSheet';
import { ChannelSheets, type ChannelSheet } from './ChannelSheets';
import { CircleThread } from './CircleThread';
import { CirclesMark } from './CirclesMark';
import { CircleTile } from './PlaceSwitcher';
import { peopleLine } from './peopleLine';
import './circleChat.css';

/** General exists before the channels have been read. */
const GENERAL: CircleChannel = { id: 'general', name: 'General', unread: 0 };

/** Online people first, the user last (Circle chats spec decision 3). */
function peopleInOrder(circle: CircleSnapshot): CircleMemberView[] {
  return [...circle.members].sort(
    (a, b) => Number(a.isMe) - Number(b.isMe) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
  );
}

function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M10 2.5v11" />
    </svg>
  );
}

const OnlineDot: React.FC<{ online: boolean }> = ({ online }) => (
  <i className={`wb-online-dot${online ? '' : ' is-off'}`} role="img" aria-label={online ? 'Online' : 'Offline'} />
);

function memberLine(member: CircleMemberView): string {
  return `${member.role === 'admin' ? 'Admin · ' : ''}${member.online ? 'Online' : 'Offline'}`;
}

/** The inspector's Circle tab (ADR 0043 §3): the Circle, its channels and its people. */
const CircleTab: React.FC<{
  circle: CircleSnapshot;
  channels: CircleChannel[];
  /** The person whose details replace the tab, by identity. */
  person: string | null;
  onPerson: (identity: string | null) => void;
  onClose: () => void;
  onManage: () => void;
  /** Admins add, rename and remove channels here. */
  onChannelSheet: (sheet: ChannelSheet) => void;
  /** Only while the call transport check is on. */
  onCallCheck?: () => void;
}> = ({ circle, channels, person, onPerson: setPerson, onClose, onManage, onChannelSheet, onCallCheck }) => {
  const admin = circle.myRole === 'admin';
  const member = person ? (circle.members.find((item) => item.identity === person) ?? null) : null;
  const offer = member ? circle.offers.find((item) => item.identity === member.identity) : undefined;
  return (
    <aside className="wb-right wb-circle-insp" aria-label="Circle details">
      <nav className="wb-insp-tabs" aria-label="Inspector">
        {member ? (
          <button type="button" className="wb-insp-tab" onClick={() => setPerson(null)}>
            ‹ Back
          </button>
        ) : (
          <span className="wb-insp-tab is-on">Circle</span>
        )}
        <button type="button" className="wb-act wb-circle-insp-close" aria-label="Close Circle details" onClick={onClose}>
          ✕
        </button>
      </nav>
      {member ? (
        <div className="wb-insp-pane">
          <div className="wb-circle-insp-ident">
            <Avatar name={member.name} seed={member.identity} large />
            <span>
              <span className="who-name">{member.isMe ? `${member.name} (you)` : member.name}</span>
              <span className="who-meta">{memberLine(member)}</span>
            </span>
          </div>
          <p className="wb-circle-insp-note">
            {offer?.models.length
              ? `Shares ${offer.models.map((model) => model.id).join(', ')}.`
              : 'Shares no models in this Circle.'}{' '}
            Trust and use are on the Circles screen.
          </p>
          <button type="button" className="wb-btn-tiny" onClick={onManage}>
            Open in Circles
          </button>
        </div>
      ) : (
        <div className="wb-insp-pane">
          <div className="wb-circle-insp-ident">
            <CircleTile circle={circle} size={34} />
            <span>
              <span className="who-name">{circle.name}</span>
              <span className="who-meta">{peopleLine(circle)}</span>
            </span>
          </div>
          <h3 className="wb-circle-insp-head">Channels</h3>
          <ul className="wb-circle-insp-list">
            {channels.map((channel) => (
              <li key={channel.id} className="wb-circle-insp-row">
                <CirclesMark size={14} />
                <span className="wb-circle-insp-copy">{channel.name}</span>
                {admin ? (
                  <button
                    type="button"
                    className="wb-btn-tiny"
                    aria-label={`Rename ${channel.name}`}
                    onClick={() => onChannelSheet({ kind: 'rename', channel })}
                  >
                    Rename
                  </button>
                ) : null}
                {admin && channel.id !== 'general' ? (
                  <button
                    type="button"
                    className="wb-btn-tiny"
                    aria-label={`Remove ${channel.name}`}
                    onClick={() => onChannelSheet({ kind: 'remove', channel })}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {admin ? (
            <button type="button" className="wb-btn-tiny" onClick={() => onChannelSheet({ kind: 'add' })}>
              Add a channel
            </button>
          ) : null}
          <h3 className="wb-circle-insp-head">People</h3>
          <ul className="wb-circle-insp-list">
            {peopleInOrder(circle).map((item) => (
              <li key={item.identity}>
                <button type="button" className="wb-circle-insp-row" onClick={() => setPerson(item.identity)}>
                  <Avatar name={item.name} seed={item.identity} />
                  <span className="wb-circle-insp-copy">
                    <span>{item.isMe ? 'You' : item.name}</span>
                    <small>{memberLine(item)}</small>
                  </span>
                  <OnlineDot online={item.online} />
                </button>
              </li>
            ))}
          </ul>
          <div className="wb-circle-insp-foot">
            <button type="button" className="wb-btn-tiny" onClick={onManage}>
              {circle.myRole === 'admin' ? 'Invite and manage…' : 'Manage…'}
            </button>
            {onCallCheck ? (
              <button type="button" className="wb-btn-tiny" onClick={onCallCheck}>
                Call check…
              </button>
            ) : null}
          </div>
        </div>
      )}
    </aside>
  );
};

export interface CirclePlaceProps {
  circle: CircleSnapshot;
  /** The Circle's channels with unread counts; General alone until they are read. */
  channels: CircleChannel[] | undefined;
  channelId: string;
  onOpenChannel: (channelId: string) => void;
  /** The place switcher, at the top of the rail. */
  switcher: React.ReactNode;
  /** The Circles screen, where people, invites and sharing are managed for now. */
  onManage: () => void;
}

/**
 * The chat screen in a Circle place (ADR 0042 §10): the Circle's rail, the open channel and the
 * Circle tab. Nothing from This Mac shows here.
 */
export const CirclePlace: React.FC<CirclePlaceProps> = ({
  circle,
  channels: read,
  channelId,
  onOpenChannel,
  switcher,
  onManage,
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
                <button
                  type="button"
                  className="wb-sect-add"
                  title="Add a channel"
                  aria-label="Add a channel"
                  onClick={() => setChannelSheet({ kind: 'add' })}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M7 2.75v8.5M2.75 7h8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
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
            </div>
            {peopleInOrder(circle).map((member) => (
              <button
                key={member.identity}
                type="button"
                className="wb-row has-mark"
                title={member.isMe ? 'Your details' : `${member.name}’s details`}
                onClick={() => {
                  setInspector(true);
                  setPerson(member.identity);
                }}
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
          channels={channels}
          person={person}
          onPerson={setPerson}
          onClose={() => setInspector(false)}
          onManage={onManage}
          onChannelSheet={setChannelSheet}
          onCallCheck={callCheck ? () => setCallCheckOpen(true) : undefined}
        />
      ) : null}

      {callCheck ? (
        <CallCheckSheet check={callCheck} circle={circle} open={callCheckOpen} onClose={() => setCallCheckOpen(false)} />
      ) : null}

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
