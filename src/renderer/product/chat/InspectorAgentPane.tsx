import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentProfile } from '../../../shared/types/hermesChat';
import { AgentMark } from './ConversationMark';
import type { AgentWritingVoices } from '../../../shared/types/writingVoices';
import { WritingVoicePicker } from '../writingVoices/WritingVoicePicker';
import { useWritingVoiceOptions } from '../writingVoices/useWritingVoiceOptions';
import { Button } from '../../components/ui/button';

/** Lines of role shown before "Show more" in the Agent tab. */
const ROLE_LINES = 4;

/**
 * The agent's two writing voices (ADR 0056 §5). A personality changes them in its edit sheet;
 * the built-in agent has none, so its pickers are here and save on change.
 */
function AgentVoices({ agent }: { agent: AgentProfile }) {
  const voices = useWritingVoiceOptions();
  const [current, setCurrent] = useState<AgentWritingVoices>({
    chatRepliesVoiceId: agent.chatRepliesVoiceId ?? null,
    draftsVoiceId: agent.draftsVoiceId ?? null,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCurrent({ chatRepliesVoiceId: agent.chatRepliesVoiceId ?? null, draftsVoiceId: agent.draftsVoiceId ?? null });
    setError(null);
  }, [agent.slug, agent.chatRepliesVoiceId, agent.draftsVoiceId]);

  const save = (next: AgentWritingVoices) => {
    const before = current;
    setCurrent(next);
    setError(null);
    void window.electronAPI.agents.setWritingVoices(agent.slug, next).then((result) => {
      if (!result.success) {
        setCurrent(before);
        setError(result.error);
      }
    });
  };

  const name = (id: string | null) => (id ? (voices.find((v) => v.id === id)?.name ?? id) : 'No voice');

  return (
    <div className="wb-insp-soul">
      <div className="kicker">Writing voice</div>
      {agent.builtIn ? (
        <>
          <WritingVoicePicker
            label="Chat replies"
            value={current.chatRepliesVoiceId}
            voices={voices}
            onChange={(id) => save({ ...current, chatRepliesVoiceId: id })}
          />
          <WritingVoicePicker
            label="Drafts"
            value={current.draftsVoiceId}
            voices={voices}
            onChange={(id) => save({ ...current, draftsVoiceId: id })}
          />
        </>
      ) : (
        <dl className="wb-insp-voices">
          <dt>Chat replies</dt>
          <dd>{name(current.chatRepliesVoiceId)}</dd>
          <dt>Drafts</dt>
          <dd>{name(current.draftsVoiceId)}</dd>
        </dl>
      )}
      {error ? <p className="wb-insp-note">{error}</p> : null}
    </div>
  );
}

/**
 * A created agent's soul opens with its role, so its excerpt (the first paragraph, clipped
 * with an ellipsis) would only repeat it.
 */
function repeatsRole(excerpt: string, role: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const head = norm(excerpt.replace(/…$/, ''));
  return head.length > 0 && norm(role).startsWith(head);
}

export function AgentPane({
  agent,
  onAddToChannel,
  onEdit,
}: {
  agent: AgentProfile;
  onAddToChannel: () => void;
  onEdit?: () => void;
}) {
  const [canOpen, setCanOpen] = useState(false);
  const [soulExcerpt, setSoulExcerpt] = useState<string | null>(null);
  const roleRef = useRef<HTMLParagraphElement>(null);
  const [roleLong, setRoleLong] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCanOpen(false);
    setSoulExcerpt(null);
    void window.electronAPI.agents.getSoul({ slug: agent.slug }).then((result) => {
      if (cancelled || !result.success) return;
      setCanOpen(Boolean(result.canOpen));
      setSoulExcerpt(result.excerpt ?? null);
    });
    return () => {
      cancelled = true;
    };
    // An edit rewrites the soul, so a new name or role reloads it.
  }, [agent.slug, agent.displayName, agent.role]);

  useLayoutEffect(() => setRoleOpen(false), [agent.slug]);

  // The role is the agent's standing instructions and can run to paragraphs.
  useLayoutEffect(() => {
    const body = roleRef.current;
    if (!body) return undefined;
    const measure = () => {
      const line = parseFloat(getComputedStyle(body).lineHeight) || 20;
      setRoleLong(body.scrollHeight > line * ROLE_LINES + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [agent.role]);

  return (
    <div className="wb-insp-pane">
      <div className="wb-insp-ident">
        <AgentMark agent={agent} size={24} />
        <span>
          <span className="who-name">{agent.displayName}</span>
          <span className="who-meta">
            {agent.builtIn ? 'Built-in · this machine' : `@${agent.handle} · Direct message`}
          </span>
        </span>
      </div>
      <div className="wb-insp-soul">
        <div className="kicker">Role</div>
        <p ref={roleRef} className={roleLong && !roleOpen ? 'is-clamped' : undefined}>
          {agent.role}
        </p>
        {roleLong ? (
          <button
            type="button"
            className="wb-show-more"
            aria-expanded={roleOpen}
            onClick={() => setRoleOpen((v) => !v)}
          >
            {roleOpen ? 'Show less' : 'Show more'}
          </button>
        ) : null}
      </div>
      {soulExcerpt && !repeatsRole(soulExcerpt, agent.role) ? (
        <div className="wb-insp-soul">
          <div className="kicker">Soul</div>
          <p>{soulExcerpt}</p>
        </div>
      ) : null}
      <AgentVoices agent={agent} />
      <p className="wb-insp-note">Private memory. Shared folder only when a project is bound.</p>
      <div className="wb-insp-actions">
        <Button variant="secondary" size="sm" type="button" onClick={onAddToChannel}>
          Add to channel
        </Button>
        {onEdit ? (
          <Button variant="secondary" size="sm" type="button" onClick={onEdit}>
            Edit
          </Button>
        ) : null}
        {canOpen ? (
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => void window.electronAPI.agents.revealSoul({ slug: agent.slug })}
          >
            Open SOUL.md
          </Button>
        ) : null}
      </div>
    </div>
  );
}
