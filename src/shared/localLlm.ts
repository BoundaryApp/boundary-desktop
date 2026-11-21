import type { DiscoveredLocalLlm } from './types/onboarding';
import { joinNames } from './utils/format';

export function hasLoadedLocalLlmModel(endpoint: DiscoveredLocalLlm): boolean {
  return endpoint.models.some((model) => model.loaded);
}

export function preferredLocalLlmModelId(endpoint: DiscoveredLocalLlm): string | undefined {
  return endpoint.models.find((model) => model.loaded)?.id ?? endpoint.models[0]?.id;
}

export function formatLocalLlmNames(endpoints: DiscoveredLocalLlm[]): string {
  const names = [...new Set(endpoints.map((endpoint) => endpoint.displayName))];
  return joinNames(names);
}
