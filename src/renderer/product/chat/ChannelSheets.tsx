import React, { useEffect, useMemo, useState } from 'react';
import {
  agentSlugFromDisplayName,
  BUILTIN_ASSISTANT_SLUG,
  type AgentProfile,
  type ChannelRecord,
} from '../../../shared/types/hermesChat';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { useEscapeToClose } from '../useAppShortcuts';
import { InfoTip } from '../../components/ui/info-tip';

interface ChannelCreateSheetProps {
  open: boolean;
  busy?: boolean;
  error?: string | null;
  agents: AgentProfile[];
  onCancel: () => void;
  onCreate: (payload: {
    title: string;
    slug: string;
    memberSlugs: string[];
  }) => void;
}

export const ChannelCreateSheet: React.FC<ChannelCreateSheetProps> = ({
  open,
  busy = false,
  error = null,
  agents,
  onCancel,
  onCreate,
}) => {
  useEscapeToClose(onCancel, busy || !open);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  // Hermes starts in every new room so there is always someone to @ (ADR 0023 §9).
  const [memberSlugs, setMemberSlugs] = useState<string[]>([BUILTIN_ASSISTANT_SLUG]);

  useEffect(() => {
    if (!open) {
      setTitle('');
      setSlug('');
      setSlugTouched(false);
      setMemberSlugs([BUILTIN_ASSISTANT_SLUG]);
    }
  }, [open]);

  const derivedSlug = useMemo(() => agentSlugFromDisplayName(title), [title]);

  if (!open) return null;

  const toggleMember = (agentSlug: string) => {
    setMemberSlugs((prev) =>
      prev.includes(agentSlug)
        ? prev.filter((s) => s !== agentSlug)
        : [...prev, agentSlug]
    );
  };

  return (
    <div className="wb-sheet-backdrop" role="presentation">
      <div
        className="wb-sheet"
        role="dialog"
        aria-labelledby="wb-channel-create-title"
      >
        <div className="wb-sheet-kicker">New channel · shared transcript</div>
        <h2>
          <span id="wb-channel-create-title">New channel</span>
          <InfoTip label="channels">
            A topic room. You post; members read later. @ is how you ask someone to reply now.
          </InfoTip>
        </h2>
        <p className="wb-sheet-lede">
          {builtinAgentName(agents)} starts as a member; uncheck it for a room nobody answers in.
        </p>
        <label className="wb-field">
          <span>Name</span>
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!slugTouched) setSlug(agentSlugFromDisplayName(e.target.value));
            }}
            disabled={busy}
            autoFocus
            placeholder="launch-prep"
          />
        </label>
        <label className="wb-field">
          <span>Slug</span>
          <input
            className="mono"
            value={slug || derivedSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            disabled={busy}
          />
        </label>
        <div className="wb-field">
          <span>Initial members</span>
          <div className="wb-member-picks">
            {[...agents].sort((a, b) => Number(b.builtIn) - Number(a.builtIn)).map((agent) => {
              const on = memberSlugs.includes(agent.slug);
              return (
                <button
                  key={agent.slug}
                  type="button"
                  className={`wb-btn-tiny${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => toggleMember(agent.slug)}
                >
                  {on ? '✓ ' : ''}
                  {agent.displayName}
                </button>
              );
            })}
          </div>
        </div>
        {error ? <p className="wb-sheet-error">{error}</p> : null}
        <div className="wb-sheet-actions">
          <button
            type="button"
            className="wb-btn-solid"
            disabled={busy || !title.trim()}
            onClick={() =>
              onCreate({
                title: title.trim(),
                slug: (slug || derivedSlug).trim(),
                memberSlugs,
              })
            }
          >
            Create channel
          </button>
          <button
            type="button"
            className="wb-btn-ghost"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

interface MakeChannelSheetProps {
  open: boolean;
  /** The built-in agent's name; it joins the new room (ADR 0023 §9). */
  builtinName: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onCreate: (payload: { title: string; slug: string }) => void;
}

export const MakeChannelSheet: React.FC<MakeChannelSheetProps> = ({
  open,
  builtinName,
  busy = false,
  error = null,
  onCancel,
  onCreate,
}) => {
  useEscapeToClose(onCancel, busy || !open);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const derivedSlug = useMemo(() => agentSlugFromDisplayName(title), [title]);

  useEffect(() => {
    if (!open) {
      setTitle('');
      setSlug('');
      setSlugTouched(false);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="wb-sheet-backdrop" role="presentation">
      <div className="wb-sheet" role="dialog" aria-labelledby="wb-make-channel-title">
        <div className="wb-sheet-kicker">Chat · become a channel</div>
        <h2 id="wb-make-channel-title">Make channel</h2>
        <p className="wb-sheet-lede">
          This chat becomes the room's transcript, and {builtinName} joins as a member.
        </p>
        <label className="wb-field">
          <span>Name</span>
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!slugTouched) setSlug(agentSlugFromDisplayName(e.target.value));
            }}
            disabled={busy}
            autoFocus
          />
        </label>
        <label className="wb-field">
          <span>Slug</span>
          <input
            className="mono"
            value={slug || derivedSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            disabled={busy}
          />
        </label>
        {error ? <p className="wb-sheet-error">{error}</p> : null}
        <div className="wb-sheet-actions">
          <button
            type="button"
            className="wb-btn-solid"
            disabled={busy || !title.trim()}
            onClick={() =>
              onCreate({
                title: title.trim(),
                slug: (slug || derivedSlug).trim(),
              })
            }
          >
            Make channel
          </button>
          <button type="button" className="wb-btn-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

interface AddToChannelSheetProps {
  open: boolean;
  agent: AgentProfile | null;
  channels: ChannelRecord[];
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onAdd: (channelId: string) => void;
}

export const AddToChannelSheet: React.FC<AddToChannelSheetProps> = ({
  open,
  agent,
  channels,
  busy = false,
  error = null,
  onCancel,
  onAdd,
}) => {
  useEscapeToClose(onCancel, busy || !open);
  if (!open || !agent) return null;

  return (
    <div className="wb-sheet-backdrop" role="presentation">
      <div className="wb-sheet" role="dialog" aria-labelledby="wb-add-channel-title">
        <div className="wb-sheet-kicker">Membership · explicit add</div>
        <h2 id="wb-add-channel-title">Add {agent.displayName} to a channel</h2>
        <p className="wb-sheet-lede">Only members can be @’d, and they read posts later.</p>
        {channels.length === 0 ? (
          <p className="wb-sheet-help">Create a channel from the left rail first.</p>
        ) : (
          <div className="wb-agent-list">
            {channels.map((ch) => {
              const already = ch.memberSlugs.includes(agent.slug);
              return (
                <div key={ch.id} className="wb-agent-row">
                  <span className="wb-agent-copy">
                    <b title={`#${ch.slug}`}>#{ch.slug}</b>
                    <span>{ch.title}</span>
                  </span>
                  <button
                    type="button"
                    className="wb-btn-tiny"
                    disabled={busy || already}
                    onClick={() => onAdd(ch.id)}
                  >
                    {already ? 'In channel' : 'Add'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {error ? <p className="wb-sheet-error">{error}</p> : null}
        <div className="wb-sheet-actions">
          <button type="button" className="wb-btn-ghost" disabled={busy} onClick={onCancel}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
};

interface ChannelRenameSheetProps {
  open: boolean;
  channel: ChannelRecord | null;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onRename: (payload: { title: string; slug: string }) => void;
}

/** Rename a room and its slug (ADR 0010 §3); members and transcript stay. */
export const ChannelRenameSheet: React.FC<ChannelRenameSheetProps> = ({
  open,
  channel,
  busy = false,
  error = null,
  onCancel,
  onRename,
}) => {
  useEscapeToClose(onCancel, busy || !open);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const derivedSlug = useMemo(() => agentSlugFromDisplayName(title), [title]);

  useEffect(() => {
    if (!open || !channel) {
      setTitle('');
      setSlug('');
      setSlugTouched(false);
      return;
    }
    setTitle(channel.title);
    setSlug(channel.slug);
    // A room whose slug was made from its name keeps following the name.
    setSlugTouched(channel.slug !== agentSlugFromDisplayName(channel.title));
  }, [open, channel]);

  if (!open || !channel) return null;

  return (
    <div className="wb-sheet-backdrop" role="presentation">
      <div className="wb-sheet" role="dialog" aria-labelledby="wb-rename-channel-title">
        <div className="wb-sheet-kicker">Channel · rename</div>
        <h2 id="wb-rename-channel-title">Rename #{channel.slug}</h2>
        <p className="wb-sheet-lede">Members and the transcript stay as they are.</p>
        <label className="wb-field">
          <span>Name</span>
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!slugTouched) setSlug(agentSlugFromDisplayName(e.target.value));
            }}
            disabled={busy}
            autoFocus
          />
        </label>
        <label className="wb-field">
          <span>Slug</span>
          <input
            className="mono"
            value={slug || derivedSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            disabled={busy}
          />
        </label>
        {error ? <p className="wb-sheet-error">{error}</p> : null}
        <div className="wb-sheet-actions">
          <button
            type="button"
            className="wb-btn-solid"
            disabled={busy || !title.trim()}
            onClick={() => onRename({ title: title.trim(), slug: (slug || derivedSlug).trim() })}
          >
            Rename
          </button>
          <button type="button" className="wb-btn-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

interface ChannelDeleteSheetProps {
  open: boolean;
  channel: ChannelRecord | null;
  /** Where the transcript is filed afterwards: the room's project, or No project. */
  projectName: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onDelete: () => void;
}

/** Delete a room; its transcript stays in Hermes as a chat (ADR 0010 §3). */
export const ChannelDeleteSheet: React.FC<ChannelDeleteSheetProps> = ({
  open,
  channel,
  projectName,
  busy = false,
  error = null,
  onCancel,
  onDelete,
}) => {
  useEscapeToClose(onCancel, busy || !open);
  if (!open || !channel) return null;

  return (
    <div className="wb-sheet-backdrop" role="presentation">
      <div className="wb-sheet" role="dialog" aria-labelledby="wb-delete-channel-title">
        <div className="wb-sheet-kicker">Channel · delete</div>
        <h2 id="wb-delete-channel-title">Delete #{channel.slug}</h2>
        <p className="wb-sheet-lede">
          The room, its members and its Mentions go. The transcript stays as a Hermes chat in{' '}
          {projectName}.
        </p>
        <p className="wb-hint" style={{ padding: 0 }}>
          Posts since the last @ never reached Hermes, so they won't be in that chat.
        </p>
        {error ? <p className="wb-sheet-error">{error}</p> : null}
        <div className="wb-sheet-actions">
          <button type="button" className="wb-btn-danger" disabled={busy} onClick={onDelete}>
            Delete channel
          </button>
          <button type="button" className="wb-btn-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
