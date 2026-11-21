import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SetupFlowShell } from '../setup/SetupFlowShell';
import { useSetup } from '../setup/SetupContext';
import { AssistantStackStartingScreen } from './AssistantStackStartingScreen';
import { AssistantStackQuitOverlay } from './AssistantStackQuitOverlay';
import { WhatsNewLayer } from './whatsNew/WhatsNewLayer';
import { ProductReadyShell } from './ProductReadyShell';
import { DESTINATIONS, type ProductDestination } from './destinations';
import { useAssistantStackLifecycle, useAssistantStackStatus } from './assistantStack';
import { probeLog } from '../debug/lagProbe';
import { BugReportLayer } from './bugReport/BugReportLayer';
import { useBugReportRequests } from './bugReport/bugReportEvents';

const SCREEN_NAMES: Record<string, string> = {
  setup: 'Setup',
  starting: 'Start-up',
  ...Object.fromEntries(DESTINATIONS.map(({ id, reportName }) => [`ready:${id}`, reportName])),
  'ready:whats-new': 'What’s new',
  'ready:settings': 'Settings',
};

/**
 * The screen a bug report names. Private experiments' screens all read "Other", because
 * reports go to a public repository.
 */
export function reportScreenName(screen: string): string {
  return SCREEN_NAMES[screen] ?? 'Other';
}

/** How long the start-up screen stays up in its ready state before the workbench (ADR 0029). */
export const READY_HOLD_MS = 700;

export const ProductApp: React.FC = () => {
  const { allComplete, setupProgress, applyFirstRunFolders } = useSetup();
  const assistantStackStatus = useAssistantStackStatus();
  const lifecycle = useAssistantStackLifecycle();
  const [view, setView] = useState<ProductDestination>('chat');
  // What's new opens at a release or a guide, depending on what asked for it.
  const [whatsNewRequest, setWhatsNewRequest] = useState<{ seq: number; version?: string; guide?: string }>({ seq: 0 });
  const openWhatsNew = useCallback((where: { version?: string; guide?: string }) => {
    setWhatsNewRequest((previous) => ({ seq: previous.seq + 1, ...where }));
    setView('whats-new');
  }, []);
  const navigate = useCallback(
    (next: ProductDestination) => {
      if (next === 'whats-new') setWhatsNewRequest((previous) => ({ seq: previous.seq + 1 }));
      setView(next);
    },
    []
  );
  // Help › Report a Bug… works in every state, so the sheet lives here (bug report spec).
  const [reporting, setReporting] = useState(false);
  useBugReportRequests(() => setReporting(true));

  const quitting = lifecycle.phase === 'stopping' || lifecycle.phase === 'stopped';
  const showStarting =
    !quitting &&
    (lifecycle.phase === 'starting' ||
      lifecycle.phase === 'error' ||
      (Boolean(assistantStackStatus?.setupComplete) &&
        !assistantStackStatus?.ready &&
        lifecycle.phase !== 'ready'));
  // When start-up finishes, keep the screen up briefly so its ready state is seen.
  const [prevShowStarting, setPrevShowStarting] = useState(showStarting);
  const [holdingReady, setHoldingReady] = useState(false);
  if (prevShowStarting !== showStarting) {
    setPrevShowStarting(showStarting);
    setHoldingReady(!showStarting && !quitting && lifecycle.phase === 'ready');
  }
  useEffect(() => {
    if (!holdingReady) return;
    const timer = setTimeout(() => setHoldingReady(false), READY_HOLD_MS);
    return () => clearTimeout(timer);
  }, [holdingReady]);
  // Folders picked in setup become projects once the stack is up; chat opens after that, on
  // the first of them (first-run spec, Phase 2). The start-up screen stays in its ready state.
  const foldersPending = allComplete && (setupProgress?.pendingFolders.length ?? 0) > 0;
  const applyingFolders = useRef(false);
  useEffect(() => {
    if (!foldersPending || showStarting || quitting || applyingFolders.current) return;
    applyingFolders.current = true;
    void applyFirstRunFolders().finally(() => {
      applyingFolders.current = false;
    });
  }, [applyFirstRunFolders, foldersPending, quitting, showStarting]);
  const starting = showStarting || holdingReady || foldersPending;
  const screen = !allComplete ? 'setup' : starting ? 'starting' : `ready:${view}`;
  // Lag probe: a screen swap unmounts the chat screen and everything in it.
  useEffect(() => {
    probeLog('app-screen', {
      screen,
      lifecyclePhase: lifecycle.phase,
      stackReady: assistantStackStatus?.ready ?? null,
    });
  }, [screen, lifecycle.phase, assistantStackStatus?.ready]);

  let main: React.ReactNode;
  if (!allComplete) {
    main = <SetupFlowShell />;
  } else if (starting) {
    main = <AssistantStackStartingScreen lifecycle={lifecycle} />;
  } else {
    main = (
      <ProductReadyShell
        view={view}
        onNavigate={navigate}
        whatsNewRequest={whatsNewRequest}
        onOpenWhatsNewGuide={(id) => openWhatsNew({ guide: id })}
        onOpenWhatsNewPage={(version) => openWhatsNew({ version })}
      />
    );
  }

  return (
    <>
      <div className="contents" inert={reporting}>
        {main}
        <AssistantStackQuitOverlay lifecycle={lifecycle} />
      </div>
      {reporting ? <BugReportLayer screen={reportScreenName(screen)} onClose={() => setReporting(false)} /> : null}
      {/* Above the start-up screen and the workbench, so notes opened while starting stay up. */}
      <WhatsNewLayer
        onOpenPage={(version) => openWhatsNew({ version })}
        onOpenGuide={(guide) => openWhatsNew({ guide })}
      />
    </>
  );
};
