import type { DiscoveredLocalLlm } from './types/onboarding';

export function hasLoadedLocalLlmModel(endpoint: DiscoveredLocalLlm): boolean {
  return endpoint.models.some((model) => model.loaded);
}

export function preferredLocalLlmModelId(endpoint: DiscoveredLocalLlm): string | undefined {
  return endpoint.models.find((model) => model.loaded)?.id ?? endpoint.models[0]?.id;
}

export function formatLocalLlmNames(endpoints: DiscoveredLocalLlm[]): string {
  const names = [...new Set(endpoints.map((endpoint) => endpoint.displayName))];
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}
