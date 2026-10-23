import Store from 'electron-store';
import {
  DEFAULT_ASSISTANT_STACK_PORTS,
  portsForIsolationMode,
} from '../../../shared/assistantStackConstants';
import type {
  AssistantStackIsolationMode,
  AssistantStackPorts,
  LastAppliedLlm,
} from '../../../shared/types/assistantStack';
import type { InferenceSlotId } from '../../../shared/types/onboarding';
import { readStoreFromMemory } from '../storeMemoryCache';

interface AssistantStackStoreShape {
  setupComplete: boolean;
  isolationMode: AssistantStackIsolationMode;
  ports: AssistantStackPorts;
  assistantRootOverride: string;
  lastAppliedLlm?: LastAppliedLlm;
}

// Read from memory: every Hermes record lookup checks the root override here.
const store = readStoreFromMemory(new Store<AssistantStackStoreShape>({
  name: 'assistant-stack',
  defaults: {
    setupComplete: false,
    isolationMode: 'default-ports',
    ports: { ...DEFAULT_ASSISTANT_STACK_PORTS },
    assistantRootOverride: '',
  },
}));

export function isAssistantStackSetupComplete(): boolean {
  return Boolean(store.get('setupComplete'));
}

export function markAssistantStackSetupComplete(): void {
  store.set('setupComplete', true);
}

export function clearAssistantStackSetupComplete(): void {
  store.set('setupComplete', false);
}

/**
 * Always return a complete port map consistent with isolationMode.
 * Older Phase‑1 store entries only had core ports offset; merging defaults left
 * Phase‑2 services on 8000/5678/etc. and broke dual-stack binds.
 */
export function getStoredAssistantPorts(): AssistantStackPorts {
  const isolationMode = getStoredIsolationMode();
  const expected = portsForIsolationMode(isolationMode);
  const raw = store.get('ports') as Partial<AssistantStackPorts> | undefined;
  const repaired =
    isolationMode === 'offset-ports'
      ? expected
      : { ...DEFAULT_ASSISTANT_STACK_PORTS, ...raw };

  // Persist repair when stored map is incomplete or mixed vs isolation mode.
  const needsPersist = (Object.keys(expected) as (keyof AssistantStackPorts)[]).some(
    (key) => raw?.[key] !== repaired[key]
  );
  if (needsPersist) {
    store.set('ports', repaired);
  }

  return repaired;
}

export function setStoredAssistantPorts(
  ports: AssistantStackPorts,
  isolationMode: AssistantStackIsolationMode
): void {
  // Normalize so offset mode never stores a partial/default mix.
  const normalized =
    isolationMode === 'offset-ports' ? portsForIsolationMode('offset-ports') : ports;
  store.set('ports', normalized);
  store.set('isolationMode', isolationMode);
}

export function getStoredIsolationMode(): AssistantStackIsolationMode {
  return store.get('isolationMode') ?? 'default-ports';
}

export function getAssistantRootOverride(): string | null {
  const value = store.get('assistantRootOverride')?.trim();
  return value || null;
}

export function setAssistantRootOverride(root: string | null): void {
  store.set('assistantRootOverride', root?.trim() ?? '');
}

function normalizeEndpointUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

export function getLastAppliedLlm(): LastAppliedLlm | null {
  return store.get('lastAppliedLlm') ?? null;
}

export function setLastAppliedLlm(value: LastAppliedLlm): void {
  store.set('lastAppliedLlm', value);
}

export function clearLastAppliedLlm(): void {
  store.delete('lastAppliedLlm');
}

export function llmFingerprintsMatch(
  applied: LastAppliedLlm | null,
  next: { slot: InferenceSlotId; endpointUrl: string; modelId: string }
): boolean {
  if (!applied) return false;
  return (
    applied.slot === next.slot &&
    applied.modelId === next.modelId &&
    normalizeEndpointUrl(applied.endpointUrl) === normalizeEndpointUrl(next.endpointUrl)
  );
}
