import React from 'react';
import { SetupShell, SetupSpinner } from './SetupShell';
import { useSetup } from './SetupContext';
import { DebugLogCopy } from '../components/settings/DebugLogCopy';
import { Callout } from '../components/ui/alert';
import { Button } from '../components/ui/button';

export const SetupFlowShell: React.FC = () => {
  const { loading, activeStep, capabilityError, capabilityAssessment, capabilityStatus, loadCapability } =
    useSetup();

  if (capabilityError && !capabilityAssessment) {
    return (
      <SetupShell
        step="capability"
        title="Couldn’t check this Mac"
        description="Boundary could not finish checking memory, disk, and the container runtime."
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

  if (loading || !activeStep) {
    return (
      <SetupShell step={null} title="Preparing Boundary" centered>
        <SetupSpinner label="Loading setup…" />
      </SetupShell>
    );
  }

  const Step = activeStep.Component;
  return <Step title={activeStep.title} description={activeStep.description} />;
};
