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
import type { DiscoveredLocalLlm } from '../../shared/types/onboarding';
import type {
  ApplyFirstRunFoldersResult,
  SetupProgress,
} from '../../shared/types/setupProgress';
import { useInferenceStatus } from '../onboarding/inferenceStatus';
import {
  useAssistantStackStatus,
  useAssistantStackStatusLoaded,
} from '../product/assistantStack';
import { setupSteps } from './steps';
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
  activeStep: SetupStepDefinition | null;
  snapshot: SetupFlowSnapshot;
  capabilityAssessment: CapabilityAssessment | null;
  capabilityStatus: CapabilityStatus | null;
  capabilityLoading: boolean;
  capabilityError: string | null;
  provisionProgress: string | null;
  /** Local LLM servers found on this Mac, kept current by main's `local-llm:changed`. */
  localLlms: DiscoveredLocalLlm[];
  discoverLocalLlms: () => Promise<void>;
  setupProgress: SetupProgress | null;
  /** Take a progress record the main process returned (after saving a step). */
  updateSetupProgress: (progress: SetupProgress) => void;
  /** **Skip for now** on an optional step. */
  skipStep: (stepId: SetupStepId) => Promise<void>;
  /** Create the Folders step's projects; call once the stack is ready. */
  applyFirstRunFolders: () => Promise<ApplyFirstRunFoldersResult | null>;
  /** Why creating the Folders step's projects failed, for the chat to show. */
  firstRunFolderError: string | null;
  /** Run the host checks again (the Machine step's Re-check). */
  assessCapability: () => Promise<CapabilityAssessment | null>;
  /** Read the stored result, assessing only if the Machine step is still open. */
  loadCapability: () => Promise<void>;
  acknowledgeCapability: () => Promise<AcknowledgeCapabilityResult>;
}

const SetupContext = createContext<SetupContextValue | undefined>(undefined);

/** The provision message to keep showing: main's latest, else the passing runtime check's. */
function stickyProvisionProgress(
  status: CapabilityStatus,
  assessment: CapabilityAssessment | null
): string | null {
  return (
    status.provisionProgress ??
    assessment?.checks.find((check) => check.id === 'runtime' && check.passed)?.detail ??
    null
  );
}

export const SetupProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { status: onboardingStatus, loading: onboardingLoading } = useInferenceStatus();

  const [capabilityStatus, setCapabilityStatus] = useState<CapabilityStatus | null>(null);
  const [capabilityAssessment, setCapabilityAssessment] = useState<CapabilityAssessment | null>(
    null
  );
  const [capabilityLoading, setCapabilityLoading] = useState(true);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [provisionProgress, setProvisionProgress] = useState<string | null>(null);
  const [localLlms, setLocalLlms] = useState<DiscoveredLocalLlm[]>([]);
  const assistantStackStatus = useAssistantStackStatus();
  const assistantStackLoaded = useAssistantStackStatusLoaded();

  const [setupProgress, setSetupProgress] = useState<SetupProgress | null>(null);
  const [setupProgressLoading, setSetupProgressLoading] = useState(true);
  const [firstRunFolderError, setFirstRunFolderError] = useState<string | null>(null);

  const refreshSetupProgress = useCallback(async () => {
    try {
      setSetupProgress(await window.electronAPI.setup.getProgress());
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
    try {
      setSetupProgress(await window.electronAPI.setup.recordOutcome({ stepId, outcome: 'skipped' }));
    } catch {
      // Main didn't store it: skip the step for this run so setup doesn't stall. It is asked
      // again on the next launch.
      setSetupProgress((prev) =>
        prev ? { ...prev, outcomes: { ...prev.outcomes, [stepId]: 'skipped' } } : prev
      );
    }
  }, []);

  const applyFirstRunFolders = useCallback(async () => {
    try {
      const result = await window.electronAPI.setup.applyFolders();
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
      const result = await window.electronAPI.onboarding.discoverLocalLlms();
      if (result.success) {
        setLocalLlms(result.endpoints);
      }
    } catch {
      // Discovery is optional and must not fail capability assessment.
    }
  }, []);

  const assessCapability = useCallback(async () => {
    setCapabilityLoading(true);
    setCapabilityError(null);
    setProvisionProgress(null);
    try {
      const [assessment] = await Promise.all([
        window.electronAPI.capability.assess(),
        discoverLocalLlms(),
      ]);
      setCapabilityAssessment(assessment);
      const status = await window.electronAPI.capability.getStatus();
      setCapabilityStatus(status);
      setProvisionProgress(stickyProvisionProgress(status, assessment));
      return assessment;
    } catch (err) {
      setCapabilityError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setCapabilityLoading(false);
    }
  }, [discoverLocalLlms]);

  useEffect(() => {
    return window.electronAPI.capability.onProgress((message) => {
      setProvisionProgress(message);
    });
  }, []);

  useEffect(() => {
    return window.electronAPI.onboarding.onLocalLlmChanged((payload) => {
      setLocalLlms(payload.endpoints);
    });
  }, []);

  const acknowledgeCapability = useCallback(async () => {
    const result = await window.electronAPI.capability.acknowledge();
    setCapabilityStatus(result.status);
    if (result.status.lastAssessment) {
      setCapabilityAssessment(result.status.lastAssessment);
    }
    // Overlap sovereign download / setup / compose with LLM onboarding.
    if (result.success) {
      void window.electronAPI.assistantStack.ensureRunningInBackground().catch(() => {
        /* lifecycle carries failures; stack step retries */
      });
    }
    return result;
  }, []);

  // A full assessment runs docker and disk probes and resets main's container runtime cache.
  // Once the Machine step is acknowledged nothing reads a fresh one, so launch reads the
  // stored status and assesses only while that step is still open.
  const loadCapability = useCallback(async () => {
    setCapabilityLoading(true);
    setCapabilityError(null);
    let status: CapabilityStatus;
    try {
      status = await window.electronAPI.capability.getStatus();
    } catch (err) {
      setCapabilityError(err instanceof Error ? err.message : String(err));
      setCapabilityLoading(false);
      return;
    }
    setCapabilityStatus(status);
    if (!status.acknowledged) {
      await assessCapability();
      return;
    }
    setCapabilityAssessment(status.lastAssessment);
    setProvisionProgress(stickyProvisionProgress(status, status.lastAssessment));
    setCapabilityLoading(false);
  }, [assessCapability]);

  useEffect(() => {
    void loadCapability();
  }, [loadCapability]);

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
    capabilityLoading ||
    setupProgressLoading ||
    !assistantStackLoaded ||
    (onboardingLoading && !onboardingStatus);

  const allComplete = useMemo(() => {
    if (loading || !capabilityStatus) return false;
    return areAllSetupStepsComplete(setupSteps(), snapshot);
  }, [loading, capabilityStatus, snapshot]);

  const activeStep = useMemo(() => {
    if (loading || !capabilityStatus) return null;
    return resolveActiveSetupStep(setupSteps(), snapshot);
  }, [loading, capabilityStatus, snapshot]);

  const value = useMemo(
    () => ({
      loading,
      allComplete,
      activeStep,
      snapshot,
      capabilityAssessment,
      capabilityStatus,
      capabilityLoading,
      capabilityError,
      provisionProgress,
      localLlms,
      discoverLocalLlms,
      setupProgress,
      updateSetupProgress: setSetupProgress,
      skipStep,
      applyFirstRunFolders,
      firstRunFolderError,
      assessCapability,
      loadCapability,
      acknowledgeCapability,
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
      loadCapability,
      capabilityAssessment,
      capabilityError,
      capabilityLoading,
      capabilityStatus,
      loading,
      provisionProgress,
      localLlms,
      discoverLocalLlms,
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
