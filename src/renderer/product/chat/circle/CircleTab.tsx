import React from 'react';
import type { CircleChannel, CircleMemberView, CircleSnapshot, CirclesState } from '../../../../shared/types/circles';
import { Avatar } from '../../circles/CircleControls';
import { isAlone, leaveConfirm, type CircleConfirm } from '../../circles/CircleConfirmSheet';
import { formatExpiry, inviteName, openInvites } from '../../circles/InviteSheet';
import { useAction } from '../../circles/useCircles';
import { openInference } from '../../inference/inferenceNavigation';
import type { ChannelSheet } from './ChannelSheets';
import { CirclesMark } from './CirclesMark';
import { CircleTile } from '../../circles/CirclesDock';
import { peopleLine } from './peopleLine';
import { CircleNotifySection } from '../../circles/CircleNotifySection';
import { Button } from '../../../components/ui/button';

const api = () => window.electronAPI.circles;

/** Online people first, the user last (Circle chats spec decision 3). */
function peopleInOrder(circle: CircleSnapshot): CircleMemberView[] {
  return [...circle.members].sort(
    (a, b) => Number(a.isMe) - Number(b.isMe) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
  );
}

export const OnlineDot: React.FC<{ online: boolean }> = ({ online }) => (
  <i className={`wb-online-dot${online ? '' : ' is-off'}`} role="img" aria-label={online ? 'Online' : 'Offline'} />
);

/** Calls go to people other than this user who are online now. */
/** Online, not you, and not the person this window is already in a call with. */
const canCall = (member: CircleMemberView, callWith: string | null | undefined): boolean =>
  !member.isMe && member.online && member.identity !== callWith;

function memberLine(member: CircleMemberView): string {
  return `${member.role === 'admin' ? 'Admin · ' : ''}${member.online ? 'Online' : 'Offline'}`;
}

/**
 * One person in this Circle (ADR 0043 §5): presence, role, what they share as plain text, and an
 * admin's membership actions. Trust and use are in Inference.
 */
const PersonView: React.FC<{
  circle: CircleSnapshot;
  member: CircleMemberView;
  onConfirm: (confirm: CircleConfirm) => void;
  onMessage?: (identity: string) => void;
  onCall?: (identity: string) => void;
  callWith?: string | null;
}> = ({ circle, member, onConfirm, onMessage, onCall, callWith }) => {
  const role = useAction();
  const offer = member.isMe ? undefined : circle.offers.find((item) => item.identity === member.identity);
  const models = offer?.models.map((model) => model.id) ?? [];
  const canManage = circle.myRole === 'admin' && !member.isMe;
  return (
    <div className="wb-insp-pane">
      <div className="wb-circle-insp-ident">
        <Avatar name={member.name} seed={member.identity} large />
        <span>
          <span className="who-name">{member.isMe ? 'You' : member.name}</span>
          <span className="who-meta">
            {member.online ? 'Online' : 'Offline'}
            {member.role === 'admin' ? ` · Admin in ${circle.name}` : ''}
          </span>
        </span>
      </div>
      {onMessage && !member.isMe ? (
        <Button variant="secondary" size="sm" type="button" className="wb-circle-insp-action" onClick={() => onMessage(member.identity)}>
          Message
        </Button>
      ) : null}
      {onCall && canCall(member, callWith) ? (
        <Button variant="secondary" size="sm" type="button" className="wb-circle-insp-action" onClick={() => onCall(member.identity)}>
          Call {member.name}
        </Button>
      ) : null}
      {member.isMe ? (
        <>
          <h3 className="wb-circle-insp-head">Shares</h3>
          <p className="wb-circle-insp-note">What this Mac shares, and with which Circles, is in Inference.</p>
          <Button variant="secondary" size="sm" type="button" className="wb-circle-insp-action" onClick={() => openInference()}>
            Open in Inference
          </Button>
        </>
      ) : models.length ? (
        <>
          <h3 className="wb-circle-insp-head">Shares</h3>
          <div className="wb-circle-insp-row">
            <span className="wb-circle-insp-copy">
              <span className="wb-circle-insp-mono">{models.join(', ')}</span>
              <small>Trust and use are in Inference.</small>
            </span>
            <Button variant="secondary" size="sm" type="button" onClick={() => openInference({ person: member.identity })}>
              Open in Inference
            </Button>
          </div>
        </>
      ) : (
        <p className="wb-circle-insp-note">Shares no models in this Circle.</p>
      )}
      {canManage ? (
        <>
          <h3 className="wb-circle-insp-head">In {circle.name}</h3>
          <div className="wb-circle-insp-actions">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={role.busy || !circle.writable}
              onClick={() =>
                void role.run(() =>
                  api().setRole({ key: circle.key, identity: member.identity, role: member.role === 'admin' ? 'member' : 'admin' }),
                )
              }
            >
              {member.role === 'admin' ? 'Make member' : 'Make admin'}
            </Button>
            <Button
              variant="danger"
              size="sm"
              type="button"
              disabled={!circle.writable}
              onClick={() => onConfirm({ kind: 'remove', member })}
            >
              Remove from {circle.name}
            </Button>
          </div>
          {role.error ? <p className="wb-circle-insp-error">{role.error}</p> : null}
        </>
      ) : null}
    </div>
  );
};

/** The inspector's Circle tab (ADR 0043 §3): the Circle, its channels, its people and its invites. */
export const CircleTab: React.FC<{
  circle: CircleSnapshot;
  circles: CirclesState;
  channels: CircleChannel[];
  /** The start of each invite code this Mac keeps, by invite id. */
  hints: Record<string, string>;
  /** The person whose details replace the tab, by identity. */
  person: string | null;
  onPerson: (identity: string | null) => void;
  onClose: () => void;
  onInvite: () => void;
  onConfirm: (confirm: CircleConfirm) => void;
  /** Admins add, rename and remove channels here. */
  onChannelSheet: (sheet: ChannelSheet) => void;
  /** Only while the call transport check is on. */
  onCallCheck?: () => void;
  /** Admins put the open channel into select mode to remove messages. */
  onRemoveMessages?: () => void;
  /** Opens a direct conversation with a person (ADR 0054 §5). */
  onMessage?: (identity: string) => void;
  /** Call one person; offered for online people other than this user. */
  onCall?: (identity: string) => void;
  /** Who this window's call is with; they get no **Call**. */
  callWith?: string | null;
}> = ({ circle, circles, channels, hints, person, onPerson, onClose, onInvite, onConfirm, onChannelSheet, onCallCheck, onRemoveMessages, onMessage, onCall, callWith }) => {
  const admin = circle.myRole === 'admin';
  // Someone who has left the Circle closes their view.
  const member = person ? (circle.members.find((item) => item.identity === person) ?? null) : null;
  const now = Date.now();
  const invites = admin ? openInvites(circle, now) : [];
  const alone = isAlone(circle);
  return (
    <aside className="wb-right wb-circle-insp" aria-label={member ? member.name : 'Circle details'}>
      <nav className="wb-insp-tabs" aria-label="Inspector">
        {member ? (
          <button type="button" className="wb-insp-tab wb-circle-insp-back" aria-label={`Back to ${circle.name}`} onClick={() => onPerson(null)}>
            ← {circle.name}
          </button>
        ) : (
          <span className="wb-insp-tab is-on">Circle</span>
        )}
        <button type="button" className="wb-act wb-circle-insp-close" aria-label="Close Circle details" onClick={onClose}>
          ✕
        </button>
      </nav>
      {member ? (
        <PersonView circle={circle} member={member} onConfirm={onConfirm} onMessage={onMessage} onCall={onCall} callWith={callWith} />
      ) : (
        <div className="wb-insp-pane">
          <div className="wb-circle-insp-ident">
            <CircleTile circle={circle} size={34} />
            <span>
              <span className="who-name">{circle.name}</span>
              <span className="who-meta">{peopleLine(circle)}</span>
            </span>
          </div>
          {admin ? (
            <Button variant="primary" block type="button" className="wb-circle-insp-invite" disabled={!circle.writable} onClick={onInvite}>
              Invite someone
            </Button>
          ) : null}
          <h3 className="wb-circle-insp-head">Channels</h3>
          <ul className="wb-circle-insp-list">
            {channels.map((channel) => (
              <li key={channel.id} className="wb-circle-insp-row">
                <CirclesMark size={14} />
                <span className="wb-circle-insp-copy">{channel.name}</span>
                {admin ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    aria-label={`Rename ${channel.name}`}
                    onClick={() => onChannelSheet({ kind: 'rename', channel })}
                  >
                    Rename
                  </Button>
                ) : null}
                {admin && channel.id !== 'general' ? (
                  <Button
                    variant="danger"
                    size="sm"
                    type="button"
                    aria-label={`Remove ${channel.name}`}
                    onClick={() => onChannelSheet({ kind: 'remove', channel })}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {admin ? (
            <Button variant="secondary" size="sm" type="button" className="wb-circle-insp-action" onClick={() => onChannelSheet({ kind: 'add' })}>
              Add a channel
            </Button>
          ) : null}
          {admin && onRemoveMessages ? (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              className="wb-circle-insp-action"
              disabled={!circle.writable}
              onClick={onRemoveMessages}
            >
              Remove messages
            </Button>
          ) : null}
          <h3 className="wb-circle-insp-head">People</h3>
          <ul className="wb-circle-insp-list">
            {peopleInOrder(circle).map((item) => (
              <li key={item.identity} className="wb-circle-insp-person">
                <button type="button" className="wb-circle-insp-row" onClick={() => onPerson(item.identity)}>
                  <Avatar name={item.name} seed={item.identity} />
                  <span className="wb-circle-insp-copy">
                    <span>{item.isMe ? 'You' : item.name}</span>
                    <small>{memberLine(item)}</small>
                  </span>
                  <OnlineDot online={item.online} />
                </button>
                {(onMessage && !item.isMe) || (onCall && canCall(item, callWith)) ? (
                  <span className="wb-person-row-actions">
                    {onMessage && !item.isMe ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        className="wb-direct-message-btn"
                        aria-label={`Message ${item.name}`}
                        onClick={() => onMessage(item.identity)}
                      >
                        Message
                      </Button>
                    ) : null}
                    {onCall && canCall(item, callWith) ? (
                      <Button variant="secondary" size="sm" type="button" aria-label={`Call ${item.name}`} onClick={() => onCall(item.identity)}>
                        Call
                      </Button>
                    ) : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <CircleNotifySection circle={circle} />
          {invites.length ? (
            <>
              <h3 className="wb-circle-insp-head">Open invites</h3>
              <ul className="wb-circle-insp-list" aria-label="Open invites">
                {invites.map((invite) => (
                  <li key={invite.id}>
                    <button type="button" className="wb-circle-insp-row" onClick={onInvite}>
                      <span className="wb-circle-insp-copy">
                        <span>{inviteName(circles, invite.id, hints)}</span>
                        <small>{formatExpiry(invite.expires, now)} · works once</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="wb-circle-insp-foot">
            <Button
              variant="danger"
              size="sm"
              type="button"
              disabled={!circle.writable}
              onClick={() => onConfirm(leaveConfirm(circle))}
            >
              {alone ? `Delete ${circle.name}` : `Leave ${circle.name}`}
            </Button>
            {onCallCheck ? (
              <Button variant="secondary" size="sm" type="button" onClick={onCallCheck}>
                Call check…
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </aside>
  );
};
