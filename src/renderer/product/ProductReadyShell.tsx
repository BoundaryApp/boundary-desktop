import React, { Profiler, useEffect, useState } from 'react';
import type { AppCommand } from '../../shared/appCommands';
import { dispatchAppCommand, useAppCommand, useAppShortcuts } from './useAppShortcuts';
import { ProductIconRail, type ProductDestination } from './ProductIconRail';
import { AssistantServicesScreen } from './AssistantServicesScreen';
import { ProductSettingsScreen } from './ProductSettingsScreen';
import { ResourcesScreen } from './ResourcesScreen';
import { CirclesScreen } from './circles/CirclesScreen';
import { WorkbenchChatScreen } from './chat/WorkbenchChatScreen';
import { useOpenSettingsRequests, type OpenSettingsRequest } from './settingsNavigation';
import { onReactRender } from '../debug/lagProbe';
import { experimentDestinations } from '../experiments';
import { useTaskOpenRequest } from './chat/kanbanActivity';
import 'streamdown/styles.css';
import './chat/workbench.css';

interface ProductReadyShellProps {
  view: ProductDestination;
  onNavigate: (view: ProductDestination) => void;
}

export const ProductReadyShell: React.FC<ProductReadyShellProps> = ({
  view,
  onNavigate,
}) => {
  useAppShortcuts();
  // Chat commands pressed elsewhere switch to Chat first, then replay there.
  const [pendingChatCommand, setPendingChatCommand] = useState<AppCommand | null>(null);
  // A request to open Settings on a tab; `seq` remounts Settings so it takes effect again.
  const [settingsRequest, setSettingsRequest] = useState<(OpenSettingsRequest & { seq: number }) | null>(
    null
  );

  useOpenSettingsRequests((request) => {
    setSettingsRequest((prev) => ({ ...request, seq: (prev?.seq ?? 0) + 1 }));
    onNavigate('settings');
  });

  useAppCommand((command) => {
    if (command === 'go-chat') onNavigate('chat');
    else if (command === 'go-services') onNavigate('services');
    else if (command === 'go-resources') onNavigate('resources');
    else if (command === 'go-circles') onNavigate('circles');
    else if (command === 'go-settings') {
      setSettingsRequest(null);
      onNavigate('settings');
    }
    else if (view !== 'chat') {
      setPendingChatCommand(command);
      onNavigate('chat');
    }
  });

  // A task notification was clicked: its page lives on the chat screen.
  const taskOpen = useTaskOpenRequest();
  useEffect(() => {
    if (taskOpen && view !== 'chat') onNavigate('chat');
  }, [taskOpen, view, onNavigate]);

  useEffect(() => {
    if (view !== 'chat' || !pendingChatCommand) return;
    setPendingChatCommand(null);
    dispatchAppCommand(pendingChatCommand);
  }, [pendingChatCommand, view]);

  const experiment = view.startsWith('experiment:')
    ? experimentDestinations().find(({ id }) => view === `experiment:${id}`)
    : undefined;

  let main: React.ReactNode;
  if (experiment) {
    main = <experiment.Screen />;
  } else if (view === 'settings') {
    main = (
      <ProductSettingsScreen
        key={settingsRequest?.seq ?? 0}
        initialTab={settingsRequest?.tab}
        initialAgentSlug={settingsRequest?.agentSlug}
        connectCalendarFromChat={settingsRequest?.connectFromChat}
        onBack={() => onNavigate('chat')}
      />
    );
  } else if (view === 'services') {
    main = <AssistantServicesScreen />;
  } else if (view === 'resources') {
    main = <ResourcesScreen />;
  } else if (view === 'circles') {
    main = <CirclesScreen />;
  } else {
    main = <WorkbenchChatScreen />;
  }

  return (
    <div className="workbench flex h-screen w-screen overflow-hidden">
      <ProductIconRail active={view} onNavigate={onNavigate} />
      {/* Keep this a flex column: screens scroll by taking `flex: 1; min-height: 0` here.
          As a plain block they grow to their content and the overflow is clipped. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Chat draws its own band from the rail and thread headers. */}
        {view === 'chat' ? null : <div className="wb-titlebar-band" aria-hidden="true" />}
        <Profiler id={`screen:${view}`} onRender={onReactRender}>
          {main}
        </Profiler>
      </div>
    </div>
  );
};
