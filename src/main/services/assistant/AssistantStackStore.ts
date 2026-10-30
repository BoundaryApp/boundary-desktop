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
import { sameEndpoint } from '../../../shared/utils/endpointUrl';

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

/**
 * Always return a complete port map consistent with isolationMode. Offset mode ignores the
 * stored map; default mode fills ports a stored map lacks from the defaults.
 */
export function getStoredAssistantPorts(): AssistantStackPorts {
  const isolationMode = getStoredIsolationMode();
  if (isolationMode === 'offset-ports') return portsForIsolationMode(isolationMode);
  const raw = store.get('ports') as Partial<AssistantStackPorts> | undefined;
  return { ...DEFAULT_ASSISTANT_STACK_PORTS, ...raw };
}

/**
 * One-time migration (src/main/migrations): older Phase‑1 store entries only had core ports
 * offset; merging defaults left Phase‑2 services on 8000/5678/etc. and broke dual-stack binds.
 * Writes the complete map back when the stored one is incomplete or mixed.
 */
export function repairStoredAssistantPorts(): void {
  const isolationMode = getStoredIsolationMode();
  const expected = portsForIsolationMode(isolationMode);
  const raw = store.get('ports') as Partial<AssistantStackPorts> | undefined;
  const repaired = getStoredAssistantPorts();
  const needsPersist = (Object.keys(expected) as (keyof AssistantStackPorts)[]).some(
    (key) => raw?.[key] !== repaired[key]
  );
  if (needsPersist) store.set('ports', repaired);
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

export function getLastAppliedLlm(): LastAppliedLlm | null {
  return store.get('lastAppliedLlm') ?? null;
}

export function setLastAppliedLlm(value: LastAppliedLlm): void {
  store.set('lastAppliedLlm', value);
}

export function clearLastAppliedLlm(): void {
  store.delete('lastAppliedLlm');
}

/**
 * Whether what Hermes and llm-proxy hold matches `next`. With `routed` given, whether llm-proxy
 * goes through the router must match too, and for a routed chain so must the context length
 * Hermes was sized for (ADR 0033 §8–9).
 */
export function llmFingerprintsMatch(
  applied: LastAppliedLlm | null,
  next: {
    slot: InferenceSlotId;
    endpointUrl: string;
    modelId: string;
    routed?: boolean;
    contextLength?: number;
  }
): boolean {
  if (!applied) return false;
  if (next.routed !== undefined) {
    if (Boolean(applied.routed) !== next.routed) return false;
    if (next.routed && applied.contextLength !== next.contextLength) return false;
  }
  return (
    applied.slot === next.slot &&
    applied.modelId === next.modelId &&
    sameEndpoint(applied.endpointUrl, next.endpointUrl)
  );
}
