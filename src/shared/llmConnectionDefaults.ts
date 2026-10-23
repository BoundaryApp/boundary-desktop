import type { LlmConnectionCapabilities } from './types/onboarding';

export const MANUAL_LLM_CAPABILITIES: LlmConnectionCapabilities = {
  kind: 'manual',
  modelChangePolicy: 'selectable',
  endpointChangePolicy: 'editable',
  supportsModelRefresh: true,
};

export const LOCAL_LLM_CAPABILITIES: LlmConnectionCapabilities = {
  kind: 'local-llm',
  modelChangePolicy: 'selectable',
  endpointChangePolicy: 'editable',
  supportsModelRefresh: true,
};

export const OAUTH_LLM_CAPABILITIES: LlmConnectionCapabilities = {
  kind: 'oauth',
  modelChangePolicy: 'selectable',
  endpointChangePolicy: 'fixed',
  supportsModelRefresh: true,
};

export const INFRASTRUCTURE_LLM_CAPABILITIES: LlmConnectionCapabilities = {
  kind: 'infrastructure',
  modelChangePolicy: 'fixed',
  endpointChangePolicy: 'fixed',
  supportsModelRefresh: false,
};
