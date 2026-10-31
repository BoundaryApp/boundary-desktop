import type { StartupDownload } from '../startupDownload';
import type { IpcResult } from '../ipc/result';
export type AssistantStackIsolationMode = 'default-ports' | 'offset-ports';

export interface AssistantStackPorts {
  gateway: number;
  apiServer: number;
  dashboard: number;
  webui: number;
  searxng: number;
  lightrag: number;
  neo4jHttp: number;
  neo4jBolt: number;
  opencode: number;
  gptResearcher: number;
  n8n: number;
  /** llm-proxy admin API (loopback only); inference stays on the compose network. */
  llmProxyAdmin: number;
}

export type AssistantStackPortKey = keyof AssistantStackPorts;

export interface AssistantUiServiceCard {
  id: string;
  title: string;
  description: string;
  portKey: AssistantStackPortKey;
  path: string;
  url: string;
}

/** The stack Boundary's Hermes records belong to: a local checkout or the managed install. */
export interface AssistantStackIdentityInfo {
  kind: 'managed' | 'local';
  root: string;
}

export interface AssistantStackStatus {
  projectName: string;
  assistantRoot: string | null;
  /** Which stack this session is bound to; local while developing against a checkout. */
  stack?: AssistantStackIdentityInfo;
  assistantRootError?: string;
  dataDir: string | null;
  overlayPath: string | null;
  ports: AssistantStackPorts;
  isolationMode: AssistantStackIsolationMode;
  apiBaseUrl: string;
  healthUrl: string;
  setupComplete: boolean;
  ready: boolean;
  lastError?: string;
  /** Browser-openable UI services with resolved localhost URLs. */
  uiServices: AssistantUiServiceCard[];
}

export interface EnsureAssistantStackResult {
  success: boolean;
  status: AssistantStackStatus;
  error?: string;
}

export interface LastAppliedLlm {
  slot: import('./inferenceChain').InferenceChainSlot;
  endpointUrl: string;
  modelId: string;
  /** Context window the model server reported for it, when it said. */
  contextLength?: number;
  /** llm-proxy was pointed at the inference router for a chain (ADR 0033). */
  routed?: boolean;
  appliedAt: string;
}

export interface ApplyAssistantLlmResult extends IpcResult {
  /** Stopped by the caller's signal before the restart; the stack may need putting back. */
  cancelled?: boolean;
}

/** What an apply is doing, for a caller that shows progress. */
export type HermesApplyStage = 'applying' | 'restarting' | 'starting';

export type StopAssistantStackResult = IpcResult;

export type AssistantStackServiceProgressState =
  | 'pending'
  | 'working'
  | 'done'
  | 'error';

export interface AssistantStackServiceProgress {
  id: string;
  containerName: string;
  title: string;
  state: AssistantStackServiceProgressState;
  statusText: string;
  /** 0–1 fill for left-to-right progress UI. */
  progress: number;
}

export type AssistantStackLifecyclePhase =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'error';

/** Coarse bring-up stages shown while per-service cards may be idle. */
export type AssistantStackLifecycleStage =
  | 'idle'
  | 'provision'
  | 'hostSetup'
  | 'hermesInit'
  | 'compose'
  | 'health'
  | 'configureLlm'
  | 'ready'
  | 'error';

export interface AssistantStackLifecycleSnapshot {
  phase: AssistantStackLifecyclePhase;
  /** Current coarse stage within starting/ready/error. */
  stage?: AssistantStackLifecycleStage;
  /** Epoch ms when the current stage began. */
  stageStartedAt?: number;
  /** Epoch ms of the last lifecycle update (heartbeat or real progress). */
  updatedAt?: number;
  message?: string;
  services: AssistantStackServiceProgress[];
  error?: string;
  /** Image bytes pulled so far in this start (ADR 0029); absent until a pull reports sizes. */
  download?: StartupDownload;
}
