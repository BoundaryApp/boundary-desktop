import React, { Profiler, useEffect, useState } from 'react';
import type { AppCommand } from '../../shared/appCommands';
import { dispatchAppCommand, useAppCommand, useAppShortcuts } from './useAppShortcuts';
import { ProductIconRail } from './ProductIconRail';
import { destinationFor, destinationForCommand, type ProductDestination } from './destinations';
import { ProductSettingsScreen } from './ProductSettingsScreen';
import { SettingsSheet } from './SettingsSheet';
import { UpdateCard } from './updates';
import { CircleOfferAlerts } from './circles/CircleOfferAlerts';
import { PlacedCallBar } from './circles/calls/PlacedCallBar';
import { RingCards } from './circles/calls/RingCards';
import { AddonStoppedAlerts } from './addons/AddonStoppedAlert';
import { useOpenInferenceRequests } from './inference/inferenceNavigation';
import { useCallCheck } from './circles/useCallCheck';
import { useCircleNotificationClicks } from './circles/useCircleViewing';
import { ChatRuntimeHost } from './chat/chatRuntimeHost';
import { WhatsNewScreen } from './whatsNew/WhatsNewScreen';
import { GuideScreen } from './whatsNew/GuideScreen';
import { AgentButton } from './agentButton/AgentButton';
import { isBottomRight, useAgentButtonSpot } from './agentButton/agentButtonSpot';
import { DesktopAgentHost } from './desktopAgent/DesktopAgentHost';
import { DesktopAgentButton } from './desktopAgent/DesktopAgentButton';
import { DesktopAgentPanel } from './desktopAgent/DesktopAgentPanel';
import { useDesktopAgentSwitch } from './desktopAgent/useDesktopAgentSwitch';
import {
  isSettingsPanelTab,
  openSettings,
  useOpenSettingsRequests,
  type OpenSettingsRequest,
  type SettingsPanelTab,
} from './settingsNavigation';
import { onReactRender } from '../debug/lagProbe';
import { experimentDestinations, rendererExperiments } from '../experiments';
import { useTaskOpenRequest } from './chat/kanbanActivity';
import 'streamdown/styles.css';
import './chat/workbench.css';

interface ProductReadyShellProps {
  view: ProductDestination;
  onNavigate: (view: ProductDestination) => void;
  /** Where to open What's new: a release to scroll to, or a guide. */
  whatsNewRequest?: { seq: number; version?: string; guide?: string };
  onOpenWhatsNewGuide?: (id: string) => void;
  /** Back from a guide to the page, at a release when one is given. */
  onOpenWhatsNewPage?: (version?: string) => void;
}

export const ProductReadyShell: React.FC<ProductReadyShellProps> = ({
  view,
  onNavigate,
  whatsNewRequest,
  onOpenWhatsNewGuide,
  onOpenWhatsNewPage,
}) => {
  useAppShortcuts();
  useCircleNotificationClicks();
  // While the call transport check is on, this Mac answers other members' test offers anywhere.
  useCallCheck();
  // Chat commands pressed elsewhere switch to Chat first, then replay there.
  const [pendingChatCommand, setPendingChatCommand] = useState<AppCommand | null>(null);
  // A request to open Settings on a tab; `seq` remounts Settings so it takes effect again.
  const [settingsRequest, setSettingsRequest] = useState<(OpenSettingsRequest & { seq: number }) | null>(
    null
  );

  // A panel opened from another screen: it sits over that screen, which stays mounted.
  const [sheetRequest, setSheetRequest] = useState<(OpenSettingsRequest & { tab: SettingsPanelTab }) | null>(
    null
  );

  useOpenSettingsRequests((request) => {
    const { tab } = request;
    // General, and any id that isn't a panel, opens the full screen; it shows General for both.
    if (!isSettingsPanelTab(tab) || view === 'settings') {
      setSettingsRequest((prev) => ({ ...request, seq: (prev?.seq ?? 0) + 1 }));
      onNavigate('settings');
    } else {
      setSheetRequest({ ...request, tab });
    }
  });

  useEffect(() => setSheetRequest(null), [view]);

  // Ids only, for the tool that tells a developer's agent what's open (ADR 0040 §4).
  const sheet = sheetRequest?.tab ?? null;
  useEffect(() => {
    void window.electronAPI?.hostBridge?.reportScreen?.({ view, sheet });
  }, [view, sheet]);

  // A link about a model: Inference, at that person's row when one is named (ADR 0043 §6).
  const [inferencePerson, setInferencePerson] = useState<{ person?: string; seq: number }>({ seq: 0 });
  // Each request to open the add-provider sheet counts up; leaving Inference forgets it, so a
  // later visit doesn't open the sheet again.
  const [addProviderRequest, setAddProviderRequest] = useState(0);
  useEffect(() => {
    if (view !== 'inference') setAddProviderRequest(0);
  }, [view]);
  useOpenInferenceRequests(({ person, addConfidentialProvider }) => {
    setInferencePerson((was) => ({ person, seq: was.seq + 1 }));
    if (addConfidentialProvider) setAddProviderRequest((was) => was + 1);
    onNavigate('inference');
  });

  useAppCommand((command) => {
    // The report sheet sits above this shell and takes this one itself (BugReportHost).
    if (command === 'report-bug') return;
    // ⌘J belongs to the agent button: the in-window one, which does nothing on Chat, or the
    // desktop panel's host, which toggles the panel from any screen (ADR 0058 §11).
    if (command === 'toggle-agent') return;
    const destination = destinationForCommand(command);
    if (destination) onNavigate(destination.id);
    else if (command === 'go-settings') {
      setSettingsRequest(null);
      onNavigate('settings');
    }
    else if (view !== 'chat') {
      setPendingChatCommand(command);
      onNavigate('chat');
    }
  });

  // Boundary menu → Check for Updates…
  useEffect(
    () => window.electronAPI?.updates?.onOpen(() => openSettings({ tab: 'updates' })),
    []
  );

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

  // With the desktop button on, the agent's button lives on the desktop, not in the window (ADR 0058 §2).
  const desktopSwitch = useDesktopAgentSwitch();
  const desktopAgent = desktopSwitch.available && desktopSwitch.on;
  // Otherwise it is everywhere but Chat, where the agent's chats are the screen (ADR 0052 §7).
  const agentButtonShown = view !== 'chat' && !desktopAgent;
  const agentSpot = useAgentButtonSpot();
  const agentRoom = agentButtonShown && isBottomRight(agentSpot);

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
        onBack={() => onNavigate('chat')}
      />
    );
  } else if (view === 'whats-new') {
    main = whatsNewRequest?.guide ? (
      <GuideScreen
        key={whatsNewRequest.seq}
        guideId={whatsNewRequest.guide}
        onBack={() => onOpenWhatsNewPage?.()}
      />
    ) : (
      <WhatsNewScreen
        key={whatsNewRequest?.seq ?? 0}
        scrollTo={whatsNewRequest?.version}
        onOpenGuide={(id) => onOpenWhatsNewGuide?.(id)}
      />
    );
  } else {
    // An experiment that is gone falls back to Chat.
    const destination = destinationFor(view) ?? destinationFor('chat');
    main = destination?.render({ inferencePerson, addProviderRequest });
  }

  // Agent chats live in the host, not in a screen, so a chat can be open in two views.
  return (
    <ChatRuntimeHost>
      <div className="workbench flex h-screen w-screen overflow-hidden">
        <ProductIconRail active={view} onNavigate={onNavigate} inert={Boolean(sheetRequest)} />
        {/* Keep this a flex column: screens scroll by taking `flex: 1; min-height: 0` here.
            As a plain block they grow to their content and the overflow is clipped. */}
        <div
          className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden${agentRoom ? ' wb-agent-room' : ''}`}
          inert={Boolean(sheetRequest)}
        >
          {/* Chat and Circles draw their own band from the rail and thread headers. */}
          {view === 'chat' || view === 'circles' ? null : <div className="wb-titlebar-band" aria-hidden="true" />}
          <Profiler id={`screen:${view}`} onRender={onReactRender}>
            {main}
          </Profiler>
          {/* Until the floating window lands (agent window spec phase 3), it opens Chat. */}
          <AgentButton hidden={!agentButtonShown} onOpen={() => onNavigate('chat')} />
        </div>
        <div inert={Boolean(sheetRequest)}>
          <UpdateCard onOpenUpdates={() => openSettings({ tab: 'updates' })} />
          {rendererExperiments.map(({ Overlay }, index) => (Overlay ? <Overlay key={index} /> : null))}
        </div>
        {sheetRequest ? <SettingsSheet request={sheetRequest} onClose={() => setSheetRequest(null)} /> : null}
        <CircleOfferAlerts inInference={view === 'inference'} />
        {/* Chat and Circles have the call bar at the foot of their rails; elsewhere it floats. */}
        {view === 'chat' || view === 'circles' ? null : <PlacedCallBar floating />}
        <RingCards />
        {desktopAgent ? <DesktopAgentHost button={<DesktopAgentButton />} panel={<DesktopAgentPanel />} /> : null}
        <div inert={Boolean(sheetRequest)}>
          <AddonStoppedAlerts />
        </div>
      </div>
    </ChatRuntimeHost>
  );
};
