import React, { useEffect, useState } from 'react';
import { SetupFlowShell } from '../setup/SetupFlowShell';
import { useSetup } from '../setup/SetupContext';
import { AssistantStackStartingScreen } from './AssistantStackStartingScreen';
import { AssistantStackQuitOverlay } from './AssistantStackQuitOverlay';
import { ProductReadyShell } from './ProductReadyShell';
import type { ProductDestination } from './ProductIconRail';
import { useAssistantStackLifecycle } from './useAssistantStackLifecycle';
import { probeLog } from '../debug/lagProbe';

export const ProductApp: React.FC = () => {
  const { allComplete, assistantStackStatus } = useSetup();
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
  const screen = !allComplete ? 'setup' : showStarting ? 'starting' : `ready:${view}`;
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
  if (showStarting) {
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
