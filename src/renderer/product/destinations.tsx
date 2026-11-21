import React from 'react';
import type { AppCommand } from '../../shared/appCommands';
import { useSharingAttention } from './circles/CircleSharingPanel';
import { AddonAttentionDot } from './addons/AddonStoppedAlert';
import { AssistantServicesScreen } from './AssistantServicesScreen';
import { ResourcesScreen } from './ResourcesScreen';
import { InferenceScreen } from './inference/InferenceScreen';
import { CirclesScreen } from './circles/CirclesScreen';
import { WorkbenchChatScreen } from './chat/WorkbenchChatScreen';
import { useKanbanSnapshot } from './chat/kanbanActivity';
import { useRunningTurns } from './chat/runningTurns';
import { WorkingDot } from './chat/WorkingDot';
import { AtMark } from './chat/circle/AtMark';
import { useCirclesUnread } from './circles/useCirclesUnread';
import { useAppBadge } from './appBadge';

/**
 * Where the shell can be. What's new and Settings are destinations the shell handles itself;
 * `experiment:<id>` is a screen a private experiment adds (`ExperimentDestination`).
 */
export type ProductDestination =
  | DestinationId
  | 'whats-new'
  | 'settings'
  | `experiment:${string}`;

export type DestinationId = 'chat' | 'circles' | 'inference' | 'services' | 'resources';

/** Shell state a destination's screen reads. */
export interface DestinationScreenState {
  /** A link about a model: Inference, at that person's row when one is named (ADR 0043 §6). */
  inferencePerson: { person?: string; seq: number };
  /** Counts up for each request to open Inference's add-provider sheet. */
  addProviderRequest: number;
}

export interface RailIconProps {
  active: boolean;
  /** Setup and start-up draw the rail dimmed, without counts or dots. */
  disabled: boolean;
}

export interface Destination {
  id: DestinationId;
  /** The rail button's tooltip and accessible name. */
  label: string;
  /** Its menu-bar command; the key is that command's accelerator in `APP_COMMANDS`. */
  command: AppCommand;
  /** The rail button's content: a 16px icon and any count or dot. */
  Icon: React.FC<RailIconProps>;
  render: (state: DestinationScreenState) => React.ReactNode;
  /** The screen a bug report names. */
  reportName: string;
}

function ChatIcon({ active }: RailIconProps) {
  // Off the chat screen, nothing else says an agent is still working: a chat turn, or a
  // kanban worker the dispatcher started.
  const turns = useRunningTurns();
  const boardRunning = useKanbanSnapshot().tasks.some((t) => t.status === 'running');
  const working = (turns.length > 0 || boardRunning) && !active;
  return (
    <>
      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M3 11.5V4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-4 2.5z" />
      </svg>
      {working ? <WorkingDot label="An agent is working" /> : null}
    </>
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

function CirclesIcon({ disabled }: RailIconProps) {
  return (
    <>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="8" cy="8" r="5.5" />
        <circle cx="8" cy="2.5" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="3.2" cy="10.8" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="12.8" cy="10.8" r="1.4" fill="currentColor" stroke="none" />
      </svg>
      {disabled ? null : <CircleUnreadCount />}
    </>
  );
}

function SharingAttentionDot() {
  return useSharingAttention() ? <i className="wb-attention-dot" role="img" aria-label="Members can’t use your models" /> : null;
}

function InferenceIcon({ disabled }: RailIconProps) {
  return (
    <>
      {disabled ? null : <SharingAttentionDot />}
      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M8 2.5 13.5 5.5 8 8.5 2.5 5.5z" />
        <path d="M2.5 8.5 8 11.5l5.5-3" />
        <path d="M2.5 11 8 14l5.5-3" />
      </svg>
    </>
  );
}

function ServicesIcon({ disabled }: RailIconProps) {
  return (
    <>
      {disabled ? null : <AddonAttentionDot />}
      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
        <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
        <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
        <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
      </svg>
    </>
  );
}

function ResourcesIcon() {
  return (
    <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="2.5" y="9.5" width="3" height="4" />
      <rect x="6.5" y="6.5" width="3" height="7" />
      <rect x="10.5" y="3.5" width="3" height="10" />
    </svg>
  );
}

/**
 * The destinations at the top of the icon rail, in rail order. The rail, the shortcut keys, the
 * shell's screen switch and bug reports' screen names all read this.
 */
export const DESTINATIONS: readonly Destination[] = [
  {
    id: 'chat',
    label: 'Chat',
    command: 'go-chat',
    Icon: ChatIcon,
    render: () => <WorkbenchChatScreen />,
    reportName: 'Chat',
  },
  {
    id: 'circles',
    label: 'Circles',
    command: 'go-circles',
    Icon: CirclesIcon,
    render: () => <CirclesScreen />,
    reportName: 'Circles',
  },
  {
    id: 'inference',
    label: 'Inference',
    command: 'go-inference',
    Icon: InferenceIcon,
    render: ({ inferencePerson, addProviderRequest }) => (
      <InferenceScreen focusPerson={inferencePerson} addProviderRequest={addProviderRequest} />
    ),
    reportName: 'Inference',
  },
  {
    id: 'services',
    label: 'Services',
    command: 'go-services',
    Icon: ServicesIcon,
    render: () => <AssistantServicesScreen />,
    reportName: 'Services',
  },
  {
    id: 'resources',
    label: 'Resources',
    command: 'go-resources',
    Icon: ResourcesIcon,
    render: () => <ResourcesScreen />,
    reportName: 'Resources',
  },
];

export function destinationFor(view: ProductDestination): Destination | undefined {
  return DESTINATIONS.find(({ id }) => id === view);
}

export function destinationForCommand(command: AppCommand): Destination | undefined {
  return DESTINATIONS.find((destination) => destination.command === command);
}
