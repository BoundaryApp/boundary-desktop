import React from 'react';
import { ariaShortcut, formatShortcut, type AppCommand } from '../../shared/appCommands';
import { openBugReport } from './bugReport/bugReportEvents';
import { useAssistantStackStatus } from './assistantStack';
import { useWhatsNew } from './whatsNew/state';
import { UpdateRailButton, useUpdates } from './updates';
import { isMacPlatform } from './useAppShortcuts';
import { experimentDestinations, type ExperimentDestination } from '../experiments';
import { DESTINATIONS, type ProductDestination } from './destinations';

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
  return (
    <nav aria-label="App" className={`wb-icon-rail${disabled ? ' is-disabled' : ''}`} inert={inert}>
      {stack?.kind === 'local' ? (
        <div className="wb-stack-badge" title={`Local agent stack: ${stack.root}`}>
          Local
        </div>
      ) : null}
      {DESTINATIONS.map(({ id, label, command, Icon }) => (
        <RailButton
          key={id}
          label={label}
          anchor={`rail-${id}`}
          command={command}
          active={active === id}
          onClick={() => onNavigate(id)}
          disabled={disabled}
        >
          <Icon active={active === id} disabled={disabled} />
        </RailButton>
      ))}
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
