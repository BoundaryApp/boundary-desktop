import React, { useState } from 'react';
import type {
  AgentProfile,
  ChannelRecord,
  HermesChatThreadSummary,
  HermesProjectRecord,
} from '../../../shared/types/hermesChat';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { formatDayLabel, formatMessageTime } from '../../../shared/messageTime';
import { displayHostPath, projectGlyph, projectGlyphColor } from './chatTelemetryFormat';
import { ConversationMark } from './ConversationMark';
import { conversationTitle } from './conversationKinds';
import { inProject } from './projectMove';
import { findRunningTurn, useRunningTurns } from './runningTurns';
import { WorkingDot } from './WorkingDot';

interface ProjectPaneProps {
  /** The project the rail shows; null is No project. */
  project: HermesProjectRecord | null;
  threads: HermesChatThreadSummary[];
  channels: ChannelRecord[];
  agents: AgentProfile[];
  sameChat: (a: string | null | undefined, b: string | null | undefined) => boolean;
  onOpenThread: (id: string) => void;
  onOpenChannel: (channel: ChannelRecord) => void;
  /** Start a chat here; with text, it is sent as the first message. */
  onStartChat: (text?: string) => void;
  onNewChannel: () => void;
  onRevealInFinder?: () => void;
}

function rowTime(iso: string | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';
  const day = formatDayLabel(ms);
  if (day === 'Today' || day === 'Yesterday') return formatMessageTime(ms);
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const newestFirst = (a: { updatedAt?: string }, b: { updatedAt?: string }) =>
  (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0);

/**
 * A project's home (ADR 0024 §4): start a chat that lives here, and everything already
 * filed here. Picking a project in the rail opens this; it never changes an open chat.
 */
export const ProjectPane: React.FC<ProjectPaneProps> = ({
  project,
  threads,
  channels,
  agents,
  sameChat,
  onOpenThread,
  onOpenChannel,
  onStartChat,
  onNewChannel,
  onRevealInFinder,
}) => {
  const [draft, setDraft] = useState('');
  const runningTurns = useRunningTurns();
  const hermesName = builtinAgentName(agents);
  const projectId = project?.id ?? null;
  const chats = threads
    .filter((t) => (t.kind === 'hermes' || t.kind === 'side') && inProject(t, projectId))
    .sort(newestFirst);
  const rooms = channels
    .filter((c) => (c.projectId ?? null) === projectId)
    .sort(newestFirst);
  const name = project?.name ?? 'No project';

  const start = () => {
    const text = draft.trim();
    onStartChat(text || undefined);
    setDraft('');
  };

  return (
    <div className="wb-recent-pane">
      <div className="wb-thread-head">
        <div className="wb-thread-id">
          {project ? (
            <span className="wb-glyph" style={{ background: projectGlyphColor(project.id) }}>
              {projectGlyph(project.name)}
            </span>
          ) : (
            <span className="wb-glyph is-none" aria-hidden="true">
              —
            </span>
          )}
          <span className="wb-thread-id-copy">
            <strong>{name}</strong>
            <span className="wb-thread-kind">
              {project ? (
                <>
                  Project · <span className="mono">{displayHostPath(project.hostPath)}</span>
                </>
              ) : (
                'Conversations that don’t belong to a project'
              )}
            </span>
          </span>
        </div>
        <span className="wb-grow" aria-hidden="true" />
        {project && onRevealInFinder ? (
          <span className="wb-thread-head-actions">
            <button type="button" className="wb-btn-tiny" onClick={onRevealInFinder}>
              Open in Finder
            </button>
          </span>
        ) : null}
      </div>

      <div className="wb-recent-list wb-project-page">
        <div className="wb-project-start">
          <textarea
            rows={2}
            value={draft}
            aria-label={project ? `Start a chat in ${name}` : 'Start a chat with no project'}
            placeholder={
              project
                ? `Start a chat in ${name}`
                : `Ask ${hermesName} anything · no project folder`
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                start();
              }
            }}
          />
          <div className="wb-project-start-row">
            <span className="wb-quiet">
              {project
                ? `New chats here work in ${displayHostPath(project.hostPath)}.`
                : `${hermesName} works without a project folder in these chats.`}
            </span>
            <button type="button" className="wb-btn-solid" onClick={start}>
              {draft.trim() ? 'Start chat' : 'New chat'}
            </button>
          </div>
        </div>

        <section className="wb-project-sect" aria-label="Chats">
          <div className="wb-time">
            Chats <span className="mono">{chats.length}</span>
          </div>
          {chats.length === 0 ? (
            <p className="wb-quiet">
              No chats yet. Start one above, or move one here from All chats.
            </p>
          ) : (
            chats.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className="wb-jump wb-all-row"
                onClick={() => onOpenThread(thread.id)}
              >
                <ConversationMark kind={thread.kind ?? 'hermes'} size={24} />
                <span className="wb-all-copy">
                  <span className="wb-jump-title">{conversationTitle(thread, agents)}</span>
                </span>
                {findRunningTurn(runningTurns, thread.id, sameChat) ? (
                  <WorkingDot label={`${hermesName} is working`} />
                ) : null}
                <span className="wb-all-when">{rowTime(thread.updatedAt)}</span>
              </button>
            ))
          )}
        </section>

        <section className="wb-project-sect" aria-label="Channels">
          <div className="wb-time wb-project-sect-head">
            <span>
              Channels <span className="mono">{rooms.length}</span>
            </span>
            <button type="button" className="wb-link" onClick={onNewChannel}>
              New channel
            </button>
          </div>
          {rooms.length === 0 ? (
            <p className="wb-quiet">No channels in {project ? name : 'this list'}.</p>
          ) : (
            rooms.map((room) => (
              <button
                key={room.id}
                type="button"
                className="wb-jump wb-all-row"
                onClick={() => onOpenChannel(room)}
              >
                <ConversationMark kind="channel" size={24} />
                <span className="wb-all-copy">
                  <span className="wb-jump-title mono">#{room.slug}</span>
                </span>
                <span className="wb-all-when">{rowTime(room.updatedAt)}</span>
              </button>
            ))
          )}
        </section>
      </div>
    </div>
  );
};
