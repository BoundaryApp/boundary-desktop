import { useSharingAttention } from './circles/CircleSharingPanel';
import { AddonAttentionDot } from './addons/AddonStoppedAlert';
import React from 'react';
import { ariaShortcut, formatShortcut, type AppCommand } from '../../shared/appCommands';
import { openBugReport } from './bugReport/bugReportEvents';
import { useAssistantStackStatus } from './assistantStack';
import { useKanbanSnapshot } from './chat/kanbanActivity';
import { useRunningTurns } from './chat/runningTurns';
import { WorkingDot } from './chat/WorkingDot';
import { useWhatsNew } from './whatsNew/state';
import { UpdateRailButton, useUpdates } from './updates';
import { isMacPlatform } from './useAppShortcuts';
import { experimentDestinations, type ExperimentDestination } from '../experiments';
import { AtMark } from './chat/circle/AtMark';
import { useCirclesUnread } from './circles/useCirclesUnread';
import { useAppBadge } from './appBadge';

/** `experiment:<id>` is a screen a private experiment adds (`ExperimentDestination`). */
export type ProductDestination =
  | 'chat'
  | 'circles'
  | 'inference'
  | 'services'
  | 'resources'
  | 'whats-new'
  | 'settings'
  | `experiment:${string}`;

interface ProductIconRailProps {
  active: ProductDestination | null;
  onNavigate?: (view: ProductDestination) => void;
  /** Setup and start-up render the rail dimmed and inert (ADR 0019). */
  disabled?: boolean;
  /** A sheet is open over the app: the rail stays as it looks but takes no input. */
  inert?: boolean;
}

function RailButton({
  label,
  command,
  active,
  onClick,
  disabled = false,
  children,
  className = '',
  anchor,
}: {
  label: string;
  /** Experiment destinations have no shortcut. */
  command?: AppCommand;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
  /** Names this button in generated screenshots, for a guide's numbered markers (ADR 0059). */
  anchor?: string;
}) {
  const shortcut = command ? formatShortcut(command, isMacPlatform()) : null;
  return (
    <button
      type="button"
      title={shortcut ? `${label}  ${shortcut}` : label}
      aria-label={label}
      aria-keyshortcuts={command ? ariaShortcut(command, isMacPlatform()) : undefined}
      aria-current={active ? 'page' : undefined}
      disabled={disabled}
      onClick={onClick}
      data-guide-anchor={anchor}
      className={`wb-icon-btn${active ? ' is-on' : ''}${className ? ` ${className}` : ''}`}
    >
      {children}
    </button>
  );
}

/**
 * Unread Circle messages across every Circle (ADR 0052 §5). The app icon's badge shows the same
 * total, and clears while the rail is disabled.
 */
function CircleUnreadCount() {
  const { total, mentioned } = useCirclesUnread();
  useAppBadge(total);
  return total ? (
    <span
      className={`wb-icon-count${mentioned ? ' has-mention' : ''}`}
      role="img"
      aria-label={`${total} unread in Circles${mentioned ? ', mentions you' : ''}`}
    >
      {mentioned ? <AtMark /> : null}
      {total > 99 ? '99+' : total}
    </span>
  ) : null;
}

function SharingAttentionDot() {
  return useSharingAttention() ? <i className="wb-attention-dot" role="img" aria-label="Members can’t use your models" /> : null;
}

const noAttention = () => false;

/** An experiment's rail button. Its own component so `useAttention` is called once per render. */
function ExperimentRailButton({
  destination,
  active,
  onClick,
  disabled,
}: {
  destination: ExperimentDestination;
  active: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  const { label, Icon, useAttention = noAttention } = destination;
  const attention = useAttention() && !disabled;
  return (
    <RailButton
      label={attention ? `${label}, needs attention` : label}
      active={active}
      onClick={onClick}
      disabled={disabled}
    >
      {attention ? <i className="wb-attention-dot" aria-hidden="true" /> : null}
      <Icon />
    </RailButton>
  );
}

export const ProductIconRail: React.FC<ProductIconRailProps> = ({
  active,
  onNavigate = () => undefined,
  disabled = false,
  inert = false,
}) => {
  const stack = useAssistantStackStatus()?.stack;
  const updates = useUpdates();
  const updateButton = !disabled && Boolean(updates?.version);
  const whatsNew = useWhatsNew();
  // No release notes bundled: the destination has nothing to show, so the rail doesn't offer it.
  const hasNotes = (whatsNew?.releases.length ?? 0) > 0;
  // Off the chat screen, nothing else says an agent is still working: a chat turn, or a
  // kanban worker the dispatcher started.
  const turns = useRunningTurns();
  const boardRunning = useKanbanSnapshot().tasks.some((t) => t.status === 'running');
  const working = (turns.length > 0 || boardRunning) && active !== 'chat';
  return (
    <nav aria-label="App" className={`wb-icon-rail${disabled ? ' is-disabled' : ''}`} inert={inert}>
      {stack?.kind === 'local' ? (
        <div className="wb-stack-badge" title={`Local agent stack: ${stack.root}`}>
          Local
        </div>
      ) : null}
      <RailButton
        label="Chat"
        anchor="rail-chat"
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
        label="Circles"
        anchor="rail-circles"
        command="go-circles"
        active={active === 'circles'}
        onClick={() => onNavigate('circles')}
        disabled={disabled}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="8" cy="8" r="5.5" />
          <circle cx="8" cy="2.5" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="3.2" cy="10.8" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="12.8" cy="10.8" r="1.4" fill="currentColor" stroke="none" />
        </svg>
        {disabled ? null : <CircleUnreadCount />}
      </RailButton>
      <RailButton
        label="Inference"
        anchor="rail-inference"
        command="go-inference"
        active={active === 'inference'}
        onClick={() => onNavigate('inference')}
        disabled={disabled}
      >
        {disabled ? null : <SharingAttentionDot />}
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M8 2.5 13.5 5.5 8 8.5 2.5 5.5z" />
          <path d="M2.5 8.5 8 11.5l5.5-3" />
          <path d="M2.5 11 8 14l5.5-3" />
        </svg>
      </RailButton>
      <RailButton
        label="Services"
        anchor="rail-services"
        command="go-services"
        active={active === 'services'}
        onClick={() => onNavigate('services')}
        disabled={disabled}
      >
        {disabled ? null : <AddonAttentionDot />}
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
          <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
          <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
          <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
        </svg>
      </RailButton>
      <RailButton
        label="Resources"
        anchor="rail-resources"
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
      {experimentDestinations().map((destination) => (
        <ExperimentRailButton
          key={destination.id}
          destination={destination}
          active={active === `experiment:${destination.id}`}
          onClick={() => onNavigate(`experiment:${destination.id}`)}
          disabled={disabled}
        />
      ))}
      {updateButton ? <UpdateRailButton className="end" /> : null}
      {hasNotes ? (
        <RailButton
          label="What’s new"
          anchor="rail-whats-new"
          active={active === 'whats-new'}
          onClick={() => onNavigate('whats-new')}
          disabled={disabled}
          className={updateButton ? '' : 'end'}
        >
          <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
            <path d="M6.5 2.2l1.1 3.2 3.2 1.1-3.2 1.1-1.1 3.2-1.1-3.2L2.2 6.5l3.2-1.1z" />
            <path d="M11.8 9.6l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
          </svg>
          {whatsNew?.unseen ? <i className="wb-attention-dot" aria-hidden="true" /> : null}
        </RailButton>
      ) : null}
      <RailButton
        label="Report a bug"
        anchor="rail-bug"
        command="report-bug"
        active={false}
        onClick={openBugReport}
        disabled={disabled}
        className={updateButton || hasNotes ? '' : 'end'}
      >
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <rect x="5" y="5" width="6" height="8" rx="3" />
          <path d="M6.2 5.2 5 3.5M9.8 5.2 11 3.5M5 8H2.8M13.2 8H11M5.2 11l-1.8 1.4M10.8 11l1.8 1.4" />
        </svg>
      </RailButton>
      <RailButton
        label="Settings"
        anchor="rail-settings"
        command="go-settings"
        active={active === 'settings'}
        onClick={() => onNavigate('settings')}
        disabled={disabled}
      >
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 2.8v1.4M8 11.8v1.4M2.8 8h1.4M11.8 8h1.4M4.1 4.1l1 1M10.9 10.9l1 1M11.9 4.1l-1 1M5.1 10.9l-1 1" />
        </svg>
      </RailButton>
    </nav>
  );
};
