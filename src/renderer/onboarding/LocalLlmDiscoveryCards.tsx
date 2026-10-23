import React, { useState } from 'react';
import type { DiscoveredLocalLlm } from '../../shared/types/onboarding';
import { hasLoadedLocalLlmModel, preferredLocalLlmModelId } from '../../shared/localLlm';
import { Button } from '../components/ui/button';
import { Pill } from '../components/ui/badge';
import { ChoiceRow } from './ChoiceRow';
import { ModelPicker } from './ModelPicker';

interface LocalLlmDiscoveryCardsProps {
  endpoints: DiscoveredLocalLlm[];
  onUseEndpoint: (endpoint: DiscoveredLocalLlm, modelId: string) => Promise<void>;
  variant?: 'default' | 'home';
}

export const LocalLlmDiscoveryCards: React.FC<LocalLlmDiscoveryCardsProps> = ({
  endpoints,
  onUseEndpoint,
  variant = 'default',
}) => {
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});

  if (endpoints.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {endpoints.map((endpoint) => {
        const isSelected = selectedUrl === endpoint.baseUrl;
        const canAdopt = hasLoadedLocalLlmModel(endpoint);
        const loaded = endpoint.models.filter((model) => model.loaded);
        const available = endpoint.models.filter((model) => !model.loaded);
        const defaultModelId = preferredLocalLlmModelId(endpoint) ?? '';
        const selectedModelId = selectedModels[endpoint.baseUrl] ?? defaultModelId;
        const useLabel =
          variant === 'home' ? `Use ${endpoint.displayName}` : 'Use this endpoint';

        return (
          <ChoiceRow
            key={endpoint.baseUrl}
            title={`${endpoint.displayName} on this Mac`}
            badge={
              <Pill variant={canAdopt ? 'ok' : 'warn'} dot>
                {canAdopt ? 'Detected' : 'No model loaded'}
              </Pill>
            }
            description={
              <span className="break-all font-mono">{endpoint.baseUrl}</span>
            }
            action={
              <Button
                type="button"
                variant="outline"
                disabled={isSelected || !canAdopt || !selectedModelId}
                onClick={() => {
                  setSelectedUrl(endpoint.baseUrl);
                  void onUseEndpoint(endpoint, selectedModelId).finally(() => setSelectedUrl(null));
                }}
              >
                {isSelected ? 'Connecting…' : useLabel}
              </Button>
            }
          >
            {loaded.length > 1 && canAdopt ? (
              <ModelPicker
                models={loaded.map((model) => ({ id: model.id, displayName: model.id }))}
                selectedModelId={selectedModelId}
                onSelect={(modelId) =>
                  setSelectedModels((current) => ({ ...current, [endpoint.baseUrl]: modelId }))
                }
                label="Loaded model"
              />
            ) : null}
            {(loaded.length === 1 || available.length > 0 || !canAdopt) && (
              <div className="space-y-1 text-xs text-fg-muted">
                {loaded.length === 1 && <p>Loaded: {loaded[0].id}</p>}
                {available.length > 0 && (
                  <p className="text-fg-faint">
                    Downloaded: {available.map((model) => model.id).join(', ')}
                  </p>
                )}
                {!canAdopt && <p>Load a model in {endpoint.displayName}, then it will appear here.</p>}
              </div>
            )}
            <p className="text-xs text-fg-faint">
              A local model shares memory and GPU with the assistant on this machine.
            </p>
          </ChoiceRow>
        );
      })}
    </div>
  );
};
