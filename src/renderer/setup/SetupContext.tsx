import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type {
  AcknowledgeCapabilityResult,
  CapabilityAssessment,
  CapabilityStatus,
} from '../../shared/types/capability';
import type { AssistantStackStatus } from '../../shared/types/assistantStack';
import type { DiscoveredLocalLlm } from '../../shared/types/onboarding';
import { useOnboarding } from '../onboarding/OnboardingContext';
import { capabilityIPC } from '../services/capabilityIPCService';
import { onboardingIPC } from '../services/onboardingIPCService';
import { assistantStackIPC } from '../services/assistantStackIPCService';
import { SETUP_STEPS } from './steps';
import {
  areAllSetupStepsComplete,
  resolveActiveSetupStep,
  type SetupFlowSnapshot,
  type SetupStepDefinition,
} from './types';

interface SetupContextValue {
  loading: boolean;
  allComplete: boolean;
  backgrounded: boolean;
  continueInBackground: () => void;
  activeStep: SetupStepDefinition | null;
  snapshot: SetupFlowSnapshot;
  capabilityAssessment: CapabilityAssessment | null;
  capabilityStatus: CapabilityStatus | null;
  capabilityLoading: boolean;
  capabilityError: string | null;
  provisionProgress: string | null;
  localLlms: DiscoveredLocalLlm[];
  assistantStackStatus: AssistantStackStatus | null;
  assessCapability: () => Promise<CapabilityAssessment | null>;
  acknowledgeCapability: () => Promise<AcknowledgeCapabilityResult>;
  refreshAssistantStack: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SetupContext = createContext<SetupContextValue | undefined>(undefined);

export const SetupProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const {
    status: onboardingStatus,
    loading: onboardingLoading,
    backgrounded,
    continueInBackground,
    refresh: refreshOnboarding,
  } = useOnboarding();

  const [capabilityStatus, setCapabilityStatus] = useState<CapabilityStatus | null>(null);
  const [capabilityAssessment, setCapabilityAssessment] = useState<CapabilityAssessment | null>(
    null
  );
  const [capabilityLoading, setCapabilityLoading] = useState(true);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [provisionProgress, setProvisionProgress] = useState<string | null>(null);
  const [localLlms, setLocalLlms] = useState<DiscoveredLocalLlm[]>([]);
  const [assistantStackStatus, setAssistantStackStatus] = useState<AssistantStackStatus | null>(
    null
  );

  const discoverLocalLlms = useCallback(async () => {
    try {
      const result = await onboardingIPC.discoverLocalLlms();
      if (result.success) {
        setLocalLlms(result.endpoints);
      }
    } catch {
      // Discovery is optional and must not fail capability assessment.
    }
  }, []);

  const refreshAssistantStack = useCallback(async () => {
    try {
      const status = await assistantStackIPC.getStatus();
      setAssistantStackStatus(status);
    } catch {
      setAssistantStackStatus(null);
    }
  }, []);

  const assessCapability = useCallback(async () => {
    setCapabilityLoading(true);
    setCapabilityError(null);
    setProvisionProgress(null);
    try {
      const [assessment] = await Promise.all([
        capabilityIPC.assess(),
        discoverLocalLlms(),
        refreshAssistantStack(),
      ]);
      setCapabilityAssessment(assessment);
      const status = await capabilityIPC.getStatus();
      setCapabilityStatus(status);
      const sticky =
        status.provisionProgress ??
        assessment.checks.find((check) => check.id === 'runtime' && check.passed)?.detail ??
        null;
      setProvisionProgress(sticky);
      return assessment;
    } catch (err) {
      setCapabilityError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setCapabilityLoading(false);
    }
  }, [discoverLocalLlms, refreshAssistantStack]);

  useEffect(() => {
    return capabilityIPC.onProgress((message) => {
      setProvisionProgress(message);
    });
  }, []);

  useEffect(() => {
    return onboardingIPC.onLocalLlmChanged((payload) => {
      setLocalLlms(payload.endpoints);
    });
  }, []);

  const acknowledgeCapability = useCallback(async () => {
    const result = await capabilityIPC.acknowledge();
    setCapabilityStatus(result.status);
    if (result.status.lastAssessment) {
      setCapabilityAssessment(result.status.lastAssessment);
    }
    // Overlap sovereign download / setup / compose with LLM onboarding.
    if (result.success) {
      void assistantStackIPC.ensureRunningInBackground().catch(() => {
        /* lifecycle carries failures; stack step retries */
      });
    }
    return result;
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([refreshOnboarding(), assessCapability(), refreshAssistantStack()]);
  }, [assessCapability, refreshAssistantStack, refreshOnboarding]);

  useEffect(() => {
    void assessCapability();
  }, [assessCapability]);

  const snapshot: SetupFlowSnapshot = useMemo(
    () => ({
      capabilityStatus,
      capabilityAssessment,
      onboardingStatus,
      onboardingLoading,
      assistantStackStatus,
    }),
    [
      assistantStackStatus,
      capabilityAssessment,
      capabilityStatus,
      onboardingLoading,
      onboardingStatus,
    ]
  );

  const loading = capabilityLoading || (onboardingLoading && !onboardingStatus);

  const allComplete = useMemo(() => {
    if (loading || !capabilityAssessment) return false;
    return areAllSetupStepsComplete(SETUP_STEPS, snapshot);
  }, [loading, capabilityAssessment, snapshot]);

  const activeStep = useMemo(() => {
    if (loading || !capabilityAssessment) return null;
    return resolveActiveSetupStep(SETUP_STEPS, snapshot);
  }, [loading, capabilityAssessment, snapshot]);

  const value = useMemo(
    () => ({
      loading,
      allComplete,
      backgrounded,
      continueInBackground,
      activeStep,
      snapshot,
      capabilityAssessment,
      capabilityStatus,
      capabilityLoading,
      capabilityError,
      provisionProgress,
      localLlms,
      assistantStackStatus,
      assessCapability,
      acknowledgeCapability,
      refreshAssistantStack,
      refresh,
    }),
    [
      acknowledgeCapability,
      activeStep,
      allComplete,
      assessCapability,
      assistantStackStatus,
      backgrounded,
      capabilityAssessment,
      capabilityError,
      capabilityLoading,
      capabilityStatus,
      continueInBackground,
      loading,
      provisionProgress,
      localLlms,
      refresh,
      refreshAssistantStack,
      snapshot,
    ]
  );

  return <SetupContext.Provider value={value}>{children}</SetupContext.Provider>;
};

/** Setup context when mounted under SetupProvider; undefined otherwise (e.g. isolated tests). */
export function useOptionalSetup(): SetupContextValue | undefined {
  return useContext(SetupContext);
}

export function useSetup(): SetupContextValue {
  const context = useContext(SetupContext);
  if (!context) {
    throw new Error('useSetup must be used within a SetupProvider');
  }
  return context;
}
