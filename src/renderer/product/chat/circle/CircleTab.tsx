import React from 'react';
import type { CircleChannel, CircleMemberView, CircleSnapshot, CirclesState } from '../../../../shared/types/circles';
import { Avatar } from '../../circles/CircleControls';
import type { CircleConfirm } from '../../circles/CircleConfirmSheet';
import { formatExpiry, inviteName, openInvites } from '../../circles/InviteSheet';
import { useAction } from '../../circles/useCircles';
import { openInference } from '../../inference/inferenceNavigation';
import type { ChannelSheet } from './ChannelSheets';
import { CirclesMark } from './CirclesMark';
import { CircleTile } from './PlaceSwitcher';
import { peopleLine } from './peopleLine';

const api = () => window.electronAPI.circles;

/** Online people first, the user last (Circle chats spec decision 3). */
export function peopleInOrder(circle: CircleSnapshot): CircleMemberView[] {
  return [...circle.members].sort(
    (a, b) => Number(a.isMe) - Number(b.isMe) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
  );
}

export const OnlineDot: React.FC<{ online: boolean }> = ({ online }) => (
  <i className={`wb-online-dot${online ? '' : ' is-off'}`} role="img" aria-label={online ? 'Online' : 'Offline'} />
);

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
}> = ({ circle, member, onConfirm }) => {
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
      {member.isMe ? (
        <>
          <h3 className="wb-circle-insp-head">Shares</h3>
          <p className="wb-circle-insp-note">What this Mac shares, and with which Circles, is in Inference.</p>
          <button type="button" className="wb-btn-tiny wb-circle-insp-action" onClick={() => openInference()}>
            Open in Inference
          </button>
        </>
      ) : models.length ? (
        <>
          <h3 className="wb-circle-insp-head">Shares</h3>
          <div className="wb-circle-insp-row">
            <span className="wb-circle-insp-copy">
              <span className="wb-circle-insp-mono">{models.join(', ')}</span>
              <small>Trust and use are in Inference.</small>
            </span>
            <button type="button" className="wb-btn-tiny" onClick={() => openInference({ person: member.identity })}>
              Open in Inference
            </button>
          </div>
        </>
      ) : (
        <p className="wb-circle-insp-note">Shares no models in this Circle.</p>
      )}
      {canManage ? (
        <>
          <h3 className="wb-circle-insp-head">In {circle.name}</h3>
          <div className="wb-circle-insp-actions">
            <button
              type="button"
              className="wb-btn-tiny"
              disabled={role.busy || !circle.writable}
              onClick={() =>
                void role.run(() =>
                  api().setRole({ key: circle.key, identity: member.identity, role: member.role === 'admin' ? 'member' : 'admin' }),
                )
              }
            >
              {member.role === 'admin' ? 'Make member' : 'Make admin'}
            </button>
            <button
              type="button"
              className="wb-btn-tiny is-danger"
              disabled={!circle.writable}
              onClick={() => onConfirm({ kind: 'remove', member })}
            >
              Remove from {circle.name}
            </button>
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
}> = ({ circle, circles, channels, hints, person, onPerson, onClose, onInvite, onConfirm, onChannelSheet, onCallCheck }) => {
  const admin = circle.myRole === 'admin';
  // Someone who has left the Circle closes their view.
  const member = person ? (circle.members.find((item) => item.identity === person) ?? null) : null;
  const now = Date.now();
  const invites = admin ? openInvites(circle, now) : [];
  const alone = circle.members.length === 1 && circle.members[0].isMe;
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
        <PersonView circle={circle} member={member} onConfirm={onConfirm} />
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
            <button type="button" className="wb-btn-solid wb-circle-insp-invite" disabled={!circle.writable} onClick={onInvite}>
              Invite someone
            </button>
          ) : null}
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
                    className="wb-btn-tiny is-danger"
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
            <button type="button" className="wb-btn-tiny wb-circle-insp-action" onClick={() => onChannelSheet({ kind: 'add' })}>
              Add a channel
            </button>
          ) : null}
          <h3 className="wb-circle-insp-head">People</h3>
          <ul className="wb-circle-insp-list">
            {peopleInOrder(circle).map((item) => (
              <li key={item.identity}>
                <button type="button" className="wb-circle-insp-row" onClick={() => onPerson(item.identity)}>
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
            <button
              type="button"
              className="wb-btn-tiny is-danger"
              disabled={!circle.writable}
              onClick={() => onConfirm({ kind: alone ? 'delete' : 'leave' })}
            >
              {alone ? `Delete ${circle.name}` : `Leave ${circle.name}`}
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
