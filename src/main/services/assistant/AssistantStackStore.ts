import Store from 'electron-store';
import {
  BOUNDARY_ASSISTANT_PORT_OFFSET,
  BOUNDARY_ASSISTANT_PORT_OFFSETS,
  DEFAULT_ASSISTANT_STACK_PORTS,
  portsForIsolationMode,
} from '../../../shared/assistantStackConstants';
import type {
  AssistantStackIsolationMode,
  AssistantStackPorts,
  LastAppliedLlm,
} from '../../../shared/types/assistantStack';
import { START_HISTORY_RUNS, type StartKind, type StartOffsets } from '../../../shared/startupTiming';
import type { InferenceChainSlot } from '../../../shared/types/inferenceChain';
import { isAddonId, type AddonId } from '../../../shared/types/addons';
import {
  DEFAULT_WEB_SEARCH_MODE,
  isWebSearchMode,
  type WebSearchMode,
} from '../../../shared/webSearchMode';
import { readStoreFromMemory } from '../storeMemoryCache';
import { sameEndpoint } from '../../../shared/utils/endpointUrl';

interface AssistantStackStoreShape {
  setupComplete: boolean;
  isolationMode: AssistantStackIsolationMode;
  /** Which of BOUNDARY_ASSISTANT_PORT_OFFSETS offset mode uses. Absent in older stores. */
  portOffset?: number;
  ports: AssistantStackPorts;
  assistantRootOverride: string;
  lastAppliedLlm?: LastAppliedLlm;
  /** Milestone offsets of the latest finished starts, newest last. Durations only. */
  startRuns?: Partial<Record<StartKind, StartOffsets[]>>;
  /** Whether the stack starts n8n. Absent means off. */
  n8nEnabled?: boolean;
  /**
   * Whether the stack starts LightRAG and Neo4j. Absent means off, on a stack that may still
   * have their containers from a Boundary that always started them.
   */
  lightragEnabled?: boolean;
  /** Who answers Hermes's web searches and page reads. Absent means private. */
  webSearchMode?: string;
  /**
   * Add-ons whose install finished, per resolved stack root, so a local checkout and the
   * managed stack keep separate lists. Compose calls carry the profiles and flags of the
   * active root's list. Ids can come from another build, so readers filter them.
   */
  installedAddonsByRoot?: Record<string, string[]>;
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

/**
 * Installed add-ons of the stack at `root` (a resolved root path), limited to ids this build
 * knows. The unkeyed `installedAddons` list earlier builds of this feature wrote is not read.
 */
export function getInstalledAddons(root: string): AddonId[] {
  return (store.get('installedAddonsByRoot')?.[root] ?? []).filter(isAddonId);
}

export function setAddonInstalled(root: string, id: AddonId, installed: boolean): void {
  // The whole record is written: conf reads dots in a key as a path, and roots contain dots.
  const byRoot = { ...store.get('installedAddonsByRoot') };
  const rest = (byRoot[root] ?? []).filter((a) => a !== id);
  byRoot[root] = installed ? [...rest, id] : rest;
  store.set('installedAddonsByRoot', byRoot);
}

export function getStartRuns(kind: StartKind): StartOffsets[] {
  return store.get('startRuns')?.[kind] ?? [];
}

export function recordStartRun(kind: StartKind, offsets: StartOffsets): void {
  store.set('startRuns', {
    ...store.get('startRuns'),
    [kind]: [...getStartRuns(kind), offsets].slice(-START_HISTORY_RUNS),
  });
}

export function isAssistantStackSetupComplete(): boolean {
  return Boolean(store.get('setupComplete'));
}

export function markAssistantStackSetupComplete(): void {
  store.set('setupComplete', true);
}

/**
 * The offset offset mode uses. Stores written before there was more than one offset, or holding
 * an offset Boundary no longer tries, read as the first.
 */
export function getStoredPortOffset(): number {
  const raw = store.get('portOffset');
  return (BOUNDARY_ASSISTANT_PORT_OFFSETS as readonly number[]).includes(raw ?? -1)
    ? (raw as number)
    : BOUNDARY_ASSISTANT_PORT_OFFSET;
}

/**
 * Always return a complete port map consistent with isolationMode. Offset mode ignores the
 * stored map and derives it from the stored offset; default mode fills ports a stored map
 * lacks from the defaults.
 */
export function getStoredAssistantPorts(): AssistantStackPorts {
  const isolationMode = getStoredIsolationMode();
  if (isolationMode === 'offset-ports') {
    return portsForIsolationMode(isolationMode, getStoredPortOffset());
  }
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
  const expected = portsForIsolationMode(isolationMode, getStoredPortOffset());
  const raw = store.get('ports') as Partial<AssistantStackPorts> | undefined;
  const repaired = getStoredAssistantPorts();
  const needsPersist = (Object.keys(expected) as (keyof AssistantStackPorts)[]).some(
    (key) => raw?.[key] !== repaired[key]
  );
  if (needsPersist) store.set('ports', repaired);
}

export function setStoredAssistantPorts(
  ports: AssistantStackPorts,
  isolationMode: AssistantStackIsolationMode,
  portOffset: number = BOUNDARY_ASSISTANT_PORT_OFFSET
): void {
  const offset = isolationMode === 'offset-ports' ? portOffset : 0;
  // Normalize so offset mode never stores a partial/default mix.
  const normalized =
    isolationMode === 'offset-ports' ? portsForIsolationMode('offset-ports', offset) : ports;
  store.set('ports', normalized);
  store.set('isolationMode', isolationMode);
  store.set('portOffset', offset);
}

export function getStoredIsolationMode(): AssistantStackIsolationMode {
  return store.get('isolationMode') ?? 'default-ports';
}

export function getAssistantRootOverride(): string | null {
  const value = store.get('assistantRootOverride')?.trim();
  return value || null;
}

export function isN8nEnabled(): boolean {
  return store.get('n8nEnabled') === true;
}

export function setN8nEnabled(enabled: boolean): void {
  store.set('n8nEnabled', enabled);
}

export function isLightragEnabled(): boolean {
  return store.get('lightragEnabled') === true;
}

/** True until the LightRAG setting is first written, by the switch or by the first start. */
export function isLightragSettingUnset(): boolean {
  return store.get('lightragEnabled') === undefined;
}

export function setLightragEnabled(enabled: boolean): void {
  store.set('lightragEnabled', enabled);
}

export function getWebSearchMode(): WebSearchMode {
  const value = store.get('webSearchMode');
  return isWebSearchMode(value) ? value : DEFAULT_WEB_SEARCH_MODE;
}

export function setWebSearchMode(mode: WebSearchMode): void {
  store.set('webSearchMode', mode);
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
    slot: InferenceChainSlot;
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
