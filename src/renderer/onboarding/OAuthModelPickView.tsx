import React, { useCallback, useEffect, useState } from 'react';
import type { ListedModel, OAuthPkceCredentialsBundle } from '../../shared/types/onboarding';
import { onboardingIPC } from '../services/onboardingIPCService';
import { Button } from '../components/ui/button';
import { Callout } from '../components/ui/alert';
import { useOnboarding } from './OnboardingContext';
import { ModelPicker } from './ModelPicker';

interface OAuthModelPickViewProps {
  credentials: OAuthPkceCredentialsBundle;
}

export const OAuthModelPickView: React.FC<OAuthModelPickViewProps> = ({ credentials }) => {
  const { refresh } = useOnboarding();
  const [models, setModels] = useState<ListedModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const result = await onboardingIPC.listEndpointModels({
        baseUrl: credentials.endpointUrl,
        apiKey: credentials.apiKey,
        authScheme: credentials.authScheme,
        provider: credentials.providerId,
        extraHeaders: credentials.extraHeaders,
      });
      if (!result.success) {
        setError(result.error ?? 'Unable to load models.');
        setModels([]);
        return;
      }
      setModels(result.models);
      setSelectedModelId(result.models[0]?.id ?? '');
    } finally {
      setLoadingModels(false);
    }
  }, [credentials]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const handleSave = async () => {
    if (!selectedModelId) {
      setError('Select a model before continuing.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await onboardingIPC.saveLlmConnection({
        endpointUrl: credentials.endpointUrl,
        // Prefer the securely stored key from the OAuth exchange; allow a fresh key if present.
        apiKey: credentials.apiKey,
        modelId: selectedModelId,
        provider: credentials.providerId,
        providerDisplayName: credentials.providerDisplayName,
        authScheme: credentials.authScheme,
        capabilities: credentials.capabilities,
        extraHeaders: credentials.extraHeaders,
      });
      if (!result.success) {
        setError(result.error ?? 'Unable to save LLM connection.');
        return;
      }
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Callout variant="ok">
        Signed in to {credentials.providerDisplayName}. Your API key is stored securely on this
        device.
      </Callout>
      <ModelPicker
        models={models}
        selectedModelId={selectedModelId}
        onSelect={setSelectedModelId}
        loading={loadingModels}
        error={error}
        onRefresh={() => void loadModels()}
        filterable
      />
      <div className="flex justify-end">
        <Button
          type="button"
          disabled={saving || !selectedModelId}
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Continue'}
        </Button>
      </div>
    </div>
  );
};
