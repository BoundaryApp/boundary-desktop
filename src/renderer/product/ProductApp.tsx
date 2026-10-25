import React, { useEffect, useRef, useState } from 'react';
import { SetupFlowShell } from '../setup/SetupFlowShell';
import { useSetup } from '../setup/SetupContext';
import { AssistantStackStartingScreen } from './AssistantStackStartingScreen';
import { AssistantStackQuitOverlay } from './AssistantStackQuitOverlay';
import { ProductReadyShell } from './ProductReadyShell';
import type { ProductDestination } from './ProductIconRail';
import { useAssistantStackLifecycle } from './useAssistantStackLifecycle';
import { probeLog } from '../debug/lagProbe';

/** How long the start-up screen stays up in its ready state before the workbench (ADR 0029). */
export const READY_HOLD_MS = 700;

export const ProductApp: React.FC = () => {
  const { allComplete, assistantStackStatus, setupProgress, applyFirstRunFolders } = useSetup();
  const lifecycle = useAssistantStackLifecycle();
  const [view, setView] = useState<ProductDestination>('chat');

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

  if (!allComplete) {
    return (
      <>
        <SetupFlowShell />
        <AssistantStackQuitOverlay lifecycle={lifecycle} />
      </>
    );
  }

  let main: React.ReactNode;
  if (starting) {
    main = <AssistantStackStartingScreen lifecycle={lifecycle} />;
  } else {
    main = <ProductReadyShell view={view} onNavigate={setView} />;
  }

  return (
    <>
      {main}
      <AssistantStackQuitOverlay lifecycle={lifecycle} />
    </>
  );
};
