import React from 'react';
import { formatShortcut, type AppCommand } from '../../shared/appCommands';
import { useAssistantStackStatus } from './assistantStack';
import { useKanbanSnapshot } from './chat/kanbanActivity';
import { useRunningTurns } from './chat/runningTurns';
import { WorkingDot } from './chat/WorkingDot';
import { isMacPlatform } from './useAppShortcuts';

export type ProductDestination = 'chat' | 'services' | 'resources' | 'settings';

interface ProductIconRailProps {
  active: ProductDestination | null;
  onNavigate?: (view: ProductDestination) => void;
  /** Setup and start-up render the rail dimmed and inert (ADR 0019). */
  disabled?: boolean;
}

function RailButton({
  label,
  command,
  active,
  onClick,
  disabled = false,
  children,
  className = '',
}: {
  label: string;
  command: AppCommand;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={`${label}  ${formatShortcut(command, isMacPlatform())}`}
      aria-label={label}
      aria-keyshortcuts={formatShortcut(command, isMacPlatform()).replace('⌘', 'Meta+')}
      aria-current={active ? 'page' : undefined}
      disabled={disabled}
      onClick={onClick}
      className={`wb-icon-btn${active ? ' is-on' : ''}${className ? ` ${className}` : ''}`}
    >
      {children}
    </button>
  );
}

export const ProductIconRail: React.FC<ProductIconRailProps> = ({
  active,
  onNavigate = () => undefined,
  disabled = false,
}) => {
  const stack = useAssistantStackStatus()?.stack;
  // Off the chat screen, nothing else says an agent is still working: a chat turn, or a
  // kanban worker the dispatcher started.
  const turns = useRunningTurns();
  const boardRunning = useKanbanSnapshot().tasks.some((t) => t.status === 'running');
  const working = (turns.length > 0 || boardRunning) && active !== 'chat';
  return (
    <nav aria-label="App" className={`wb-icon-rail${disabled ? ' is-disabled' : ''}`}>
      <div className="wb-mark" aria-hidden="true" />
      {stack?.kind === 'local' ? (
        <div className="wb-stack-badge" title={`Local agent stack: ${stack.root}`}>
          Local
        </div>
      ) : null}
      <RailButton
        label="Chat"
        command="go-chat"
        active={active === 'chat'}
        onClick={() => onNavigate('chat')}
        disabled={disabled}
      >
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 11.5V4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-4 2.5z" />
        </svg>
        {working ? <WorkingDot label="An agent is working" /> : null}
      </RailButton>
      <RailButton
        label="Services"
        command="go-services"
        active={active === 'services'}
        onClick={() => onNavigate('services')}
        disabled={disabled}
      >
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
          <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
          <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
          <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
        </svg>
      </RailButton>
      <RailButton
        label="Resources"
        command="go-resources"
        active={active === 'resources'}
        onClick={() => onNavigate('resources')}
        disabled={disabled}
      >
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="2.5" y="9.5" width="3" height="4" />
          <rect x="6.5" y="6.5" width="3" height="7" />
          <rect x="10.5" y="3.5" width="3" height="10" />
        </svg>
      </RailButton>
      <RailButton
        label="Settings"
        command="go-settings"
        active={active === 'settings'}
        onClick={() => onNavigate('settings')}
        disabled={disabled}
        className="end"
      >
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 2.8v1.4M8 11.8v1.4M2.8 8h1.4M11.8 8h1.4M4.1 4.1l1 1M10.9 10.9l1 1M11.9 4.1l-1 1M5.1 10.9l-1 1" />
        </svg>
      </RailButton>
    </nav>
  );
};
