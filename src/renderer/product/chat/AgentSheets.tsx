import React, { useEffect, useMemo, useState } from 'react';
import {
  agentSlugFromDisplayName,
  type AgentProfile,
} from '../../../shared/types/hermesChat';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { AgentMark } from './ConversationMark';
import { InfoTip } from '../../components/ui/info-tip';
import type { AgentWritingVoices } from '../../../shared/types/writingVoices';
import { WritingVoicePicker } from '../writingVoices/WritingVoicePicker';
import { useWritingVoiceOptions } from '../writingVoices/useWritingVoiceOptions';
import { Button } from '../../components/ui/button';

const NO_VOICES: AgentWritingVoices = { chatRepliesVoiceId: null, draftsVoiceId: null };

interface AgentCreateSheetProps {
  open: boolean;
  /** `edit` changes an existing personality's name, handle and role (ADR 0010 §4). */
  mode?: 'create' | 'edit';
  busy?: boolean;
  starting?: boolean;
  error?: string | null;
  initialValues?: {
    displayName?: string;
    handle?: string;
    role?: string;
    voices?: AgentWritingVoices;
  } | null;
  onCancel: () => void;
  onCreate: (payload: {
    displayName: string;
    handle: string;
    role: string;
    voices: AgentWritingVoices;
  }) => void;
}

export const AgentCreateSheet: React.FC<AgentCreateSheetProps> = ({
  open,
  mode = 'create',
  busy = false,
  starting = false,
  error = null,
  initialValues = null,
  onCancel,
  onCreate,
}) => {
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [role, setRole] = useState('');
  const [handleTouched, setHandleTouched] = useState(false);
  const [voices, setVoices] = useState<AgentWritingVoices>(NO_VOICES);
  const voiceOptions = useWritingVoiceOptions();

  useEffect(() => {
    if (!open) {
      setDisplayName('');
      setHandle('');
      setRole('');
      setHandleTouched(false);
      setVoices(NO_VOICES);
      return;
    }
    if (initialValues) {
      setDisplayName(initialValues.displayName ?? '');
      setHandle(initialValues.handle ?? '');
      setRole(initialValues.role ?? '');
      setHandleTouched(Boolean(initialValues.handle));
      setVoices(initialValues.voices ?? NO_VOICES);
    }
  }, [open, initialValues]);

  const derivedHandle = useMemo(
    () => agentSlugFromDisplayName(displayName),
    [displayName]
  );

  if (!open) return null;
  const editing = mode === 'edit';

  return (
    <Sheet
      open={open}
      onClose={onCancel}
      busy={busy}
      titleId="wb-agent-create-title"
      title={editing ? 'Edit agent' : 'New agent'}
      titleAside={
        editing ? null : (
          <InfoTip label="agents">
            This agent gets private memory. It can read the bound folder. In a channel it can
            read posts later; @ is how you ask it to reply now.
          </InfoTip>
        )
      }
      error={error}
      actions={
        <SheetConfirmActions
          busy={busy}
          onCancel={onCancel}
          confirmLabel={editing ? 'Save' : 'Create agent'}
          confirmDisabled={!displayName.trim() || !role.trim()}
          onConfirm={() =>
            onCreate({
              displayName: displayName.trim(),
              handle: (handle || derivedHandle).trim(),
              role: role.trim(),
              voices,
            })
          }
        />
      }
    >
      {editing ? (
        <p className="wb-sheet-lede">
          A new role becomes its standing instructions. Its DM, memory and channels stay.
        </p>
      ) : (
        <p className="wb-sheet-lede">The role becomes its standing instructions.</p>
      )}
      <label className="wb-field">
        <span>Display name</span>
        <input
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            if (!handleTouched) setHandle(agentSlugFromDisplayName(e.target.value));
          }}
          disabled={busy}
          autoFocus
        />
      </label>
      <label className="wb-field">
        <span>Handle</span>
        <input
          className="mono"
          value={handle || derivedHandle}
          onChange={(e) => {
            setHandleTouched(true);
            setHandle(e.target.value);
          }}
          disabled={busy}
        />
      </label>
      <label className="wb-field">
        <span>Role</span>
        <textarea
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={busy}
          rows={4}
        />
      </label>
      <fieldset className="wb-voice-group" disabled={busy}>
        <legend>Writing voice</legend>
        <WritingVoicePicker
          label="Chat replies"
          value={voices.chatRepliesVoiceId}
          voices={voiceOptions}
          onChange={(id) => setVoices((v) => ({ ...v, chatRepliesVoiceId: id }))}
        />
        <WritingVoicePicker
          label="Drafts"
          value={voices.draftsVoiceId}
          voices={voiceOptions}
          onChange={(id) => setVoices((v) => ({ ...v, draftsVoiceId: id }))}
        />
      </fieldset>
      {starting ? (
        <p className="wb-sheet-starting" role="status">
          Starting…
        </p>
      ) : null}
    </Sheet>
  );
};

interface AgentRosterSheetProps {
  open: boolean;
  /** `message` is the DMs plus: pick a personality to open its one thread (ADR 0023). */
  mode?: 'roster' | 'message';
  agents: AgentProfile[];
  onClose: () => void;
  onNewAgent: () => void;
  onOpenDm: (slug: string) => void;
  onAddToChannel?: (slug: string) => void;
  /** Personalities only; the built-in agent's name comes from the stack (ADR 0010 §4). */
  onEditAgent?: (slug: string) => void;
}

export const AgentRosterSheet: React.FC<AgentRosterSheetProps> = ({
  open,
  mode = 'roster',
  agents,
  onClose,
  onNewAgent,
  onOpenDm,
  onAddToChannel,
  onEditAgent,
}) => {
  if (!open) return null;
  const messaging = mode === 'message';
  const hermesName = builtinAgentName(agents);
  const listed = messaging ? agents.filter((a) => !a.builtIn) : agents;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      titleId="wb-roster-title"
      className="wb-sheet-wide"
      title={messaging ? 'Message an agent' : 'Agents'}
      titleAside={
        <InfoTip label={messaging ? 'direct messages' : 'agents'}>
          {messaging
            ? `For a fresh start, use a ${hermesName} chat (⌘N).`
            : `${hermesName} is the built-in agent you chat with any time. The others are people you DM or @ in a channel, each with private memory and a role. Past chats live in All chats.`}
        </InfoTip>
      }
      actions={
        <>
          <Button variant="secondary" block type="button" onClick={onClose}>
            Done
          </Button>
          <Button variant="primary" block type="button" onClick={onNewAgent}>
            New agent
          </Button>
        </>
      }
    >
      {messaging ? (
        <p className="wb-sheet-lede">Each agent keeps one ongoing thread with you.</p>
      ) : null}
      {listed.length === 0 ? (
        <p className="wb-sheet-help">No agents yet. Create one to start a DM.</p>
      ) : (
        <div className="wb-agent-list">
          {listed.map((agent) => (
            <div key={agent.slug} className="wb-agent-row">
              <AgentMark agent={agent} />
              <span className="wb-agent-copy">
                <b title={agent.displayName}>{agent.displayName}</b>
                <span className="role" title={agent.role}>
                  {agent.role}
                </span>
                <span className="handle mono">
                  {agent.builtIn ? 'built-in' : `@${agent.handle}`}
                </span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => onOpenDm(agent.slug)}
              >
                {agent.builtIn ? 'Chat' : messaging ? 'Message' : 'DM'}
              </Button>
              {!messaging && onAddToChannel ? (
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => onAddToChannel(agent.slug)}
                >
                  Add to channel
                </Button>
              ) : null}
              {!messaging && !agent.builtIn && onEditAgent ? (
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  aria-label={`Edit ${agent.displayName}`}
                  onClick={() => onEditAgent(agent.slug)}
                >
                  Edit
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
};
