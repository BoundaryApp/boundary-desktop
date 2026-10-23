import React, { Profiler, useEffect, useState } from 'react';
import type { AppCommand } from '../../shared/appCommands';
import { dispatchAppCommand, useAppCommand, useAppShortcuts } from './useAppShortcuts';
import { ProductIconRail, type ProductDestination } from './ProductIconRail';
import { AssistantServicesScreen } from './AssistantServicesScreen';
import { ProductSettingsScreen } from './ProductSettingsScreen';
import { ResourcesScreen } from './ResourcesScreen';
import { WorkbenchChatScreen } from './chat/WorkbenchChatScreen';
import { useOpenSettingsRequests, type OpenSettingsRequest } from './settingsNavigation';
import { onReactRender } from '../debug/lagProbe';
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

  let main: React.ReactNode;
  if (view === 'settings') {
    main = (
      <ProductSettingsScreen
        key={settingsRequest?.seq ?? 0}
        initialTab={settingsRequest?.tab}
        initialAgentSlug={settingsRequest?.agentSlug}
        onBack={() => onNavigate('chat')}
      />
    );
  } else if (view === 'services') {
    main = <AssistantServicesScreen />;
  } else if (view === 'resources') {
    main = <ResourcesScreen />;
  } else {
    main = <WorkbenchChatScreen />;
  }

  return (
    <div className="workbench flex h-screen w-screen overflow-hidden">
      <ProductIconRail active={view} onNavigate={onNavigate} />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Profiler id={`screen:${view}`} onRender={onReactRender}>
          {main}
        </Profiler>
      </div>
    </div>
  );
};
