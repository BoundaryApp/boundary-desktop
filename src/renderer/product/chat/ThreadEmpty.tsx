import React from 'react';
import type { HermesProjectRecord } from '../../../shared/types/hermesChat';

const PROJECT_STARTERS = [
  'Summarize what’s in this folder',
  'What changed here most recently?',
  'Draft a README for this project',
];

const GENERAL_STARTERS = [
  'Plan my week from a list of tasks',
  'Draft a short email asking to meet next week',
  'Explain how projects and sources work in Boundary',
];

/** What an empty transcript shows: starters for a chat, a quiet note for a room. */
export const ThreadEmpty: React.FC<{
  connecting: boolean;
  /** The room's slug in a channel, else null. */
  channelSlug: string | null;
  project: HermesProjectRecord | null;
  /** Starters fill the composer for editing; they never send on their own. */
  onStarter: (text: string) => void;
}> = ({ connecting, channelSlug, project, onStarter }) => (
  <div className="wb-log-empty">
    {connecting ? (
      <p className="wb-log-empty-sub">Connecting folder…</p>
    ) : channelSlug != null ? (
      <>
        <h2>#{channelSlug} is quiet</h2>
        <p className="wb-log-empty-sub">
          Post for the room; @ a member to ask for a reply.
        </p>
      </>
    ) : (
      <>
        <h2>{project ? `Ask about ${project.name}` : 'What can I help with?'}</h2>
        <p className="wb-log-empty-sub">
          {project
            ? 'Files stay on disk. Your assistant reads them where they are.'
            : 'Replies come from your assistant on this Mac.'}
        </p>
        <div className="wb-starters" role="list" aria-label="Starter prompts">
          {(project ? PROJECT_STARTERS : GENERAL_STARTERS).map((starter) => (
            <button
              key={starter}
              type="button"
              role="listitem"
              className="wb-starter"
              onClick={() => onStarter(starter)}
            >
              {starter}
            </button>
          ))}
        </div>
        <p className="wb-log-empty-keys">
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd> <kbd>Enter</kbd> for a new line ·{' '}
          <kbd>@</kbd> to mention
        </p>
      </>
    )}
  </div>
);
