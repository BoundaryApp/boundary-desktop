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
import type {
  ApplyFirstRunFoldersResult,
  SetupProgress,
} from '../../shared/types/setupProgress';
import { useOnboarding } from '../onboarding/OnboardingContext';
import { capabilityIPC } from '../services/capabilityIPCService';
import { onboardingIPC } from '../services/onboardingIPCService';
import { assistantStackIPC } from '../services/assistantStackIPCService';
import { setupIPC } from '../services/setupIPCService';
import { SETUP_STEPS } from './steps';
import {
  areAllSetupStepsComplete,
  resolveActiveSetupStep,
  type SetupFlowSnapshot,
  type SetupStepDefinition,
  type SetupStepId,
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
  setupProgress: SetupProgress | null;
  /** Take a progress record the main process returned (after saving a step). */
  updateSetupProgress: (progress: SetupProgress) => void;
  /** **Skip for now** on an optional step. */
  skipStep: (stepId: SetupStepId) => Promise<void>;
  /** Create the Folders step's projects; call once the stack is ready. */
  applyFirstRunFolders: () => Promise<ApplyFirstRunFoldersResult | null>;
  /** Why creating the Folders step's projects failed, for the chat to show. */
  firstRunFolderError: string | null;
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

  const [setupProgress, setSetupProgress] = useState<SetupProgress | null>(null);
  const [setupProgressLoading, setSetupProgressLoading] = useState(true);
  const [firstRunFolderError, setFirstRunFolderError] = useState<string | null>(null);

  const refreshSetupProgress = useCallback(async () => {
    try {
      setSetupProgress(await setupIPC.getProgress());
    } catch {
      // Optional steps then count as answered; setup must not stall on them.
      setSetupProgress(null);
    } finally {
      setSetupProgressLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSetupProgress();
  }, [refreshSetupProgress]);

  const skipStep = useCallback(async (stepId: SetupStepId) => {
    setSetupProgress(await setupIPC.recordOutcome(stepId, 'skipped'));
  }, []);

  const applyFirstRunFolders = useCallback(async () => {
    try {
      const result = await setupIPC.applyFolders();
      setFirstRunFolderError(result.success ? null : (result.error ?? null));
      setSetupProgress(result.progress);
      return result;
    } catch (err) {
      setFirstRunFolderError(err instanceof Error ? err.message : String(err));
      // Drop the local picks so the app moves on to chat with the error.
      setSetupProgress((prev) => (prev ? { ...prev, pendingFolders: [] } : prev));
      return null;
    }
  }, []);

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
    await Promise.all([
      refreshOnboarding(),
      assessCapability(),
      refreshAssistantStack(),
      refreshSetupProgress(),
    ]);
  }, [assessCapability, refreshAssistantStack, refreshOnboarding, refreshSetupProgress]);

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
      setupProgress,
    }),
    [
      assistantStackStatus,
      capabilityAssessment,
      capabilityStatus,
      onboardingLoading,
      onboardingStatus,
      setupProgress,
    ]
  );

  const loading =
    capabilityLoading || setupProgressLoading || (onboardingLoading && !onboardingStatus);

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
      setupProgress,
      updateSetupProgress: setSetupProgress,
      skipStep,
      applyFirstRunFolders,
      firstRunFolderError,
      assessCapability,
      acknowledgeCapability,
      refreshAssistantStack,
      refresh,
    }),
    [
      applyFirstRunFolders,
      firstRunFolderError,
      setupProgress,
      skipStep,
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
