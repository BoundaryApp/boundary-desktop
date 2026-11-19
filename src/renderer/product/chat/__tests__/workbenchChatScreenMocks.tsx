import React from 'react';

/**
 * Stand-ins for the chat runtime and thread under WorkbenchChatScreen's tests: the thread shows
 * its title, kind, handed-down draft, quote and focus as text, and a button for each callback
 * the screen passes it. Load each with `vi.mock('../WorkbenchThread', () => import('./workbenchChatScreenMocks'))`.
 */
export const HermesChatRuntimeProvider = ({ children }: { children: React.ReactNode }) => (
  <>{children}</>
);

export const WorkbenchThread = ({
  threadTitle,
  kind,
  initialDraft,
  initialQuote,
  focusText,
  dmTabs,
  onCreateAgentFromDraft,
  onRenameChannel,
  onDeleteChannel,
  onDeleteChat,
  toolsEnabled,
  onToolsEnabledChange,
}: {
  toolsEnabled?: boolean;
  onToolsEnabledChange?: (enabled: boolean) => void;
  threadTitle: string;
  kind?: string | null;
  initialDraft?: string | null;
  initialQuote?: string | null;
  focusText?: string | null;
  dmTabs?: { count: number; onChange: (tab: 'messages' | 'channels') => void } | null;
  onCreateAgentFromDraft?: (payload: { displayName: string; handle: string; role: string }) => void;
  onRenameChannel?: () => void;
  onDeleteChannel?: () => void;
  onDeleteChat?: () => void;
}) => (
  <div>
    thread:{threadTitle}
    {kind === 'side' ? ' side' : ''}
    {kind === 'channel' ? ' channel' : ''}
    {initialDraft ? <p>draft:{initialDraft}</p> : null}
    {initialQuote ? <p>quote:{initialQuote}</p> : null}
    {focusText ? <p>focus:{focusText}</p> : null}
    <button
      type="button"
      role="switch"
      aria-label="Tools"
      aria-checked={Boolean(toolsEnabled)}
      onClick={() => onToolsEnabledChange?.(!toolsEnabled)}
    />
    {onRenameChannel ? (
      <button type="button" onClick={onRenameChannel}>
        Rename channel…
      </button>
    ) : null}
    {onDeleteChannel ? (
      <button type="button" onClick={onDeleteChannel}>
        Delete channel…
      </button>
    ) : null}
    {onDeleteChat ? (
      <button type="button" onClick={onDeleteChat}>
        Delete chat…
      </button>
    ) : null}
    {onCreateAgentFromDraft ? (
      <button
        type="button"
        onClick={() =>
          onCreateAgentFromDraft({ displayName: 'Hermes', handle: 'hermes', role: 'Helps.' })
        }
      >
        Create drafted agent
      </button>
    ) : null}
    {dmTabs ? (
      <button type="button" onClick={() => dmTabs.onChange('channels')}>
        In channels {dmTabs.count}
      </button>
    ) : null}
  </div>
);
