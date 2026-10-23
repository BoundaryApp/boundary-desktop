import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { MANUAL_LLM_CAPABILITIES } from '../../shared/llmConnectionDefaults';
import { defaultSlotStatus, type ListedModel } from '../../shared/types/onboarding';
import { onboardingIPC } from '../services/onboardingIPCService';
import { Button } from '../components/ui/button';
import { Callout } from '../components/ui/alert';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { useOnboarding } from './OnboardingContext';
import { ModelPicker } from './ModelPicker';

function validateEndpointUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Endpoint URL must start with http:// or https://.';
    }
    return null;
  } catch {
    return 'Enter a valid OpenAI-compatible endpoint URL.';
  }
}

export type CredentialsFormVariant = 'custom' | 'local';

interface OpenAiCredentialsFormProps {
  variant?: CredentialsFormVariant;
}

export const OpenAiCredentialsForm: React.FC<OpenAiCredentialsFormProps> = ({
  variant = 'custom',
}) => {
  const { status, refresh } = useOnboarding();
  // The saved connection, to prefill the form.
  const saved = defaultSlotStatus(status);
  const isLocal = variant === 'local';
  const [endpointUrl, setEndpointUrl] = useState(
    saved?.endpointUrl ?? (isLocal ? 'http://127.0.0.1:11434/v1' : '')
  );
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ListedModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState(saved?.modelId ?? '');
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedApiKey = saved?.apiKey?.configured ? saved.apiKey : null;

  const handleLoadModels = async () => {
    setError(null);
    const endpointError = validateEndpointUrl(endpointUrl);
    if (endpointError) {
      setError(endpointError);
      return;
    }
    if (!apiKey.trim() && !savedApiKey && !isLocal) {
      setError('Enter an API key before loading models.');
      return;
    }

    setLoadingModels(true);
    try {
      const result = await onboardingIPC.listEndpointModels({
        baseUrl: endpointUrl,
        apiKey: apiKey.trim() || undefined,
        authScheme: 'bearer',
        provider: isLocal ? 'local-manual' : 'manual',
      });
      if (!result.success) {
        setError(result.error ?? 'Unable to load models from this endpoint.');
        setModels([]);
        setModelsLoaded(false);
        return;
      }
      setModels(result.models);
      setSelectedModelId(result.models[0]?.id ?? '');
      setModelsLoaded(true);
    } finally {
      setLoadingModels(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!selectedModelId) {
      setError('Select a model before continuing.');
      return;
    }

    setSaving(true);
    try {
      const result = await onboardingIPC.saveLlmConnection({
        endpointUrl,
        apiKey: apiKey.trim() || undefined,
        modelId: selectedModelId,
        provider: isLocal ? 'local-manual' : 'manual',
        providerDisplayName: isLocal ? 'Local server' : 'Custom endpoint',
        authScheme: 'bearer',
        capabilities: MANUAL_LLM_CAPABILITIES,
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
    <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="openai-endpoint">Endpoint URL</Label>
        <Input
          id="openai-endpoint"
          value={endpointUrl}
          onChange={(event) => {
            setEndpointUrl(event.target.value);
            setModelsLoaded(false);
          }}
          placeholder={
            isLocal ? 'http://127.0.0.1:11434/v1' : 'https://your-endpoint.example.com/v1'
          }
          autoComplete="url"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="openai-api-key">API key{isLocal ? ' (optional)' : ''}</Label>
        <Input
          id="openai-api-key"
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            setModelsLoaded(false);
          }}
          placeholder={
            savedApiKey?.preview ?? (isLocal ? 'Leave blank if not required' : 'Paste your API key')
          }
          type="password"
          autoComplete="off"
        />
        <p className="flex items-center gap-1.5 text-xs text-fg-faint">
          <ShieldCheck aria-hidden="true" className="size-3.5" />
          {savedApiKey?.preview
            ? `Saved key: ${savedApiKey.preview}. Enter a new key only to replace it.`
            : 'Encrypted with your system keychain and never shown again.'}
        </p>
      </div>

      {modelsLoaded && (
        <ModelPicker
          models={models}
          selectedModelId={selectedModelId}
          onSelect={setSelectedModelId}
          loading={loadingModels}
          onRefresh={() => void handleLoadModels()}
        />
      )}

      {status && !status.encryptionAvailable && (
        <Callout variant="warn">
          System encryption is unavailable, so Boundary cannot store API keys securely on this
          machine.
        </Callout>
      )}

      {error && <Callout variant="destructive">{error}</Callout>}

      <div className="flex justify-end gap-2">
        {!modelsLoaded ? (
          <Button
            type="button"
            disabled={loadingModels || status?.encryptionAvailable === false}
            onClick={() => void handleLoadModels()}
          >
            {loadingModels ? 'Loading models…' : 'Load models'}
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={
              saving || !modelsLoaded || !selectedModelId || status?.encryptionAvailable === false
            }
          >
            {saving ? 'Saving…' : 'Continue'}
          </Button>
        )}
      </div>
    </form>
  );
};

export const __testing = {
  validateEndpointUrl,
};
