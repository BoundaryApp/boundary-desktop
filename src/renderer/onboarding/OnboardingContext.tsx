import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type {
  InferenceProvidersStatus,
  SaveOpenAiConfigInput,
  SaveOpenAiConfigResult,
} from '../../shared/types/onboarding';
import { emptyInferenceProvidersStatus } from '../../shared/types/onboarding';
import { onboardingIPC } from '../services/onboardingIPCService';

interface OnboardingContextValue {
  status: InferenceProvidersStatus | null;
  loading: boolean;
  error: string | null;
  backgrounded: boolean;
  refresh: () => Promise<void>;
  continueInBackground: () => void;
  saveOpenAiConfig: (input: SaveOpenAiConfigInput) => Promise<SaveOpenAiConfigResult>;
}

const OnboardingContext = createContext<OnboardingContextValue | undefined>(undefined);

export const OnboardingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<InferenceProvidersStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backgrounded, setBackgrounded] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextStatus = await onboardingIPC.getStatus();
      setStatus(nextStatus);
      if (nextStatus.configured) {
        setBackgrounded(false);
      }
    } catch (err) {
      setStatus(emptyInferenceProvidersStatus(false));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const saveOpenAiConfig = useCallback(async (input: SaveOpenAiConfigInput) => {
    const result = await onboardingIPC.saveOpenAiConfig(input);
    if (result.status) {
      setStatus(result.status);
    }
    if (!result.success && result.error) {
      setError(result.error);
    } else {
      setError(null);
    }
    return result;
  }, []);

  const continueInBackground = useCallback(() => {
    setBackgrounded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!backgrounded || !status?.pending) return;
    const interval = setInterval(() => {
      void refresh();
    }, 5000);
    return () => clearInterval(interval);
  }, [backgrounded, refresh, status?.pending]);

  const value = useMemo(
    () => ({
      status,
      loading,
      error,
      backgrounded,
      refresh,
      continueInBackground,
      saveOpenAiConfig,
    }),
    [backgrounded, continueInBackground, error, loading, refresh, saveOpenAiConfig, status]
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
};

export function useOnboarding(): OnboardingContextValue {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error('useOnboarding must be used within an OnboardingProvider');
  }
  return context;
}
