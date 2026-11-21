import React from 'react';
import { SetupShell, SetupSpinner } from './SetupShell';
import { SetupPreparing } from './SetupPreparing';
import { useSetup } from './SetupContext';
import { DebugLogCopy } from '../components/settings/DebugLogCopy';
import { Callout } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { APP_NAME } from '../../shared/buildIdentity';

export const SetupFlowShell: React.FC = () => {
  const {
    loading,
    activeStep,
    capabilityError,
    capabilityAssessment,
    capabilityStatus,
    capabilityLoading,
    loadCapability,
    provisionProgress,
    provisionStage,
  } = useSetup();

  if (capabilityError && !capabilityAssessment) {
    return (
      <SetupShell
        step="capability"
        title="Couldn’t check this Mac"
        description={`${APP_NAME} could not finish checking memory, disk, and the container runtime.`}
        actions={
          <Button type="button" onClick={() => void loadCapability()}>
            Try again
          </Button>
        }
      >
        <Callout variant="destructive">{capabilityError}</Callout>
        <DebugLogCopy path={capabilityStatus?.debugLogPath} />
      </SetupShell>
    );
  }

  // The Machine check is resolving the container runtime, which can take minutes on a first
  // launch: show its steps. A launch that only reads the stored result keeps the spinner.
  if (capabilityLoading && provisionStage) {
    return (
      <SetupPreparing
        stage={provisionStage}
        message={provisionProgress}
        debugLogPath={capabilityStatus?.debugLogPath}
      />
    );
  }

  if (loading || !activeStep) {
    return (
      <SetupShell step={null} title={`Preparing ${APP_NAME}`} centered>
        <SetupSpinner label="Loading setup…" />
      </SetupShell>
    );
  }

  const Step = activeStep.Component;
  return <Step title={activeStep.title} description={activeStep.description} />;
};
