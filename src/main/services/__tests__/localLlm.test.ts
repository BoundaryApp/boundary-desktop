import { describe, expect, it } from 'vitest';
import {
  formatLocalLlmNames,
  hasLoadedLocalLlmModel,
  preferredLocalLlmModelId,
} from '../../../shared/localLlm';
import type { DiscoveredLocalLlm } from '../../../shared/types/onboarding';

const ollama: DiscoveredLocalLlm = {
  runtime: 'ollama',
  displayName: 'Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1/',
  models: [
    { id: 'mistral:7b', loaded: false },
    { id: 'llama3:latest', loaded: true },
  ],
};

describe('localLlm helpers', () => {
  it('prefers a loaded model id', () => {
    expect(hasLoadedLocalLlmModel(ollama)).toBe(true);
    expect(preferredLocalLlmModelId(ollama)).toBe('llama3:latest');
  });

  it('formats one or two display names', () => {
    expect(formatLocalLlmNames([ollama])).toBe('Ollama');
    expect(
      formatLocalLlmNames([
        ollama,
        {
          ...ollama,
          runtime: 'lmstudio',
          displayName: 'LM Studio',
          baseUrl: 'http://127.0.0.1:1234/v1',
        },
      ])
    ).toBe('Ollama and LM Studio');
  });
});
