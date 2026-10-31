import { APP_NAME, IS_SEPARATE_INSTANCE } from '../../../shared/buildIdentity';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import {
  ASSISTANT_STACK_DOWN_TIMEOUT_MS,
  ASSISTANT_STACK_HEALTH_INTERVAL_MS,
  ASSISTANT_STACK_HEALTH_TIMEOUT_MS,
  ASSISTANT_STACK_BUILD_UP_TIMEOUT_MS,
  ASSISTANT_STACK_UP_TIMEOUT_MS,
  BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE,
  BOUNDARY_ASSISTANT_COMPOSE_PROFILE,
  BOUNDARY_ASSISTANT_COMPOSE_PROFILES,
  BOUNDARY_ASSISTANT_CONTAINER_PREFIX,
  BOUNDARY_ASSISTANT_IMAGE_PREFIX,
  BOUNDARY_ASSISTANT_PROJECT_NAME,
  BOUNDARY_HERMES_TERMINAL_BACKEND,
  DEFAULT_ASSISTANT_STACK_PORTS,
  HERMES_CONFIG_PROFILES,
  LIVE_LOCAL_STACK_START_TIMEOUT_MS,
  buildComposeProfileArgs,
  portsForIsolationMode,
} from '../../../shared/assistantStackConstants';
import { buildAssistantUiServiceCards } from '../../../shared/assistantUiServices';
import { summarizeDownload, tallyDownload, type DownloadTally } from '../../../shared/startupDownload';
import {
  applyComposeProgressEvent,
  applyLocalImageListing,
  createLifecycleSnapshot,
  isLifecycleWaveBoundary,
  markStackReadyAfterEnsure,
  mergeServiceProgress,
  mergeServicesById,
  parseComposeProgressLine,
  PROGRESS,
  resolveContainerFromProgressId,
  seedServiceProgress,
  startElapsedHeartbeat,
} from '../../../shared/assistantStackLifecycle';
import type { InferenceChainSlot } from '../../../shared/types/inferenceChain';
import type {
  ApplyAssistantLlmResult,
  HermesApplyStage,
  AssistantStackIsolationMode,
  AssistantStackLifecycleSnapshot,
  AssistantStackLifecycleStage,
  AssistantStackPorts,
  AssistantStackServiceProgress,
  AssistantStackStatus,
  EnsureAssistantStackResult,
  StopAssistantStackResult,
} from '../../../shared/types/assistantStack';
import {
  getContainerRuntime,
  runCli,
  runCompose,
  runComposeStreaming,
} from '../containerRuntime';
import {
  classifyInferenceSlot,
  getAppDefaultSlot,
  getAppSharedModel,
  getLlmConnection,
} from '../onboarding/OpenAiOnboardingStore';
import {
  applyLlmConnectionToProjectFiles,
  clearLlmKeysFromProjectEnv,
} from './applyLlmToProjectEnv';
import { upsertEnvLines } from './stackEnv';
import { redactSecrets } from '../secrets/redact';
import {
  ensureAssistantDataDirs,
  ensureAssistantWorkspaceDir,
  ensureOpenCodeConfigFile,
  hermesConfigExists,
  isBoundaryOwnedAssistantRoot,
  readAssistantEnvFile,
  removeIncompleteHermesProfiles,
  resolveAssistantDataRoot,
  resolveAssistantWorkspaceRoot,
  resolveAssistantUserContentRoot,
  resolveBoundaryOverlayPath,
} from './assistantPaths';
import {
  getStoredAssistantPorts,
  getStoredIsolationMode,
  isAssistantStackSetupComplete,
  getLastAppliedLlm,
  markAssistantStackSetupComplete,
  setLastAppliedLlm,
  setStoredAssistantPorts,
} from './AssistantStackStore';
import {
  isLocalAssistantStackMode,
  localStackStopSkippedMessage,
  stackMode,
} from './localStackMode';
import { LIVE_STACK_PS_ARGS, liveForeignProjectsAt } from './liveLocalStack';
import {
  ensureSovereignProjectProvisioned,
  isHostSetupComplete,
  markHostSetupComplete,
  markImagesBuilt,
  needsImageBuild,
} from './provisionSovereignStack';
import { tryResolveAssistantRoot } from './resolveAssistantRoot';
import { listStoredHermesProjects } from './hermes/hermesProjectStore';
import { ensureHermesWorkerKey } from './hermesWorkerKey';
import {
  LLM_PROXY_CLIENT_BASE_URL,
  LLM_PROXY_PLACEHOLDER_KEY,
  pushLlmProxyUpstream,
  readLlmProxyAdminToken,
  type LlmProxyStatus,
  type LlmProxyTarget,
  type LlmProxyUpstream,
} from './llmProxyAdmin';
import {
  keepLlmProxyUpstream,
  noteLlmProxyPushed,
  stopKeepingLlmProxyUpstream,
} from './llmProxyKeyKeeper';
import { hermesStaleTimeoutFor } from './hermesStreamTimeout';
import {
  hermesMaxTokensFor,
  hermesProfileLimitSets,
  lookupModelContextLength,
  type HermesConfigCompose,
  type HermesProfileLimits,
} from './hermesProfileLimits';
import { BOUNDARY_PLATFORM_HINT, BOUNDARY_PLATFORM_HINT_KEY } from './hermesPlatformHint';
import { listStoredAgents } from './hermes/hermesAgentStore';
import { defaultMcpServerEntries } from './hermesAgentMcpServers';
import {
  buildHermesConfigApplyInput,
  hasHermesWrites,
  HERMES_CONFIG_APPLY_ARGS,
  hermesWritesNeedRestart,
  parseHermesConfigApplyOutput,
  planHermesProfileWrites,
  readHermesProfileConfig,
  type DesiredHermesProfile,
  type HermesProfileWrites,
} from './hermesConfigApply';
import { hasCalendarAccounts } from './calendar/calendarStore';
import { CALENDAR_COMPOSE_PROFILE } from './calendar/calendarModel';
import { rewriteLlmUrlForContainer } from './rewriteLlmUrlForContainer';
import { planAppInferenceChain, sharedModelConnection, type ChainPlan } from '../inference/inferenceChainService';
import {
  ensureInferenceRouter,
  HERMES_ROUTER_PROVIDER_KEY,
  HERMES_ROUTER_SESSION_HEADER,
  inferenceRouterProxyUrl,
  noteInferenceRouterPushed,
  setInferenceRouterChain,
} from '../inference/inferenceRouterService';
import { runSovereignSetup } from './runSovereignSetup';
import { syncStackImagePins } from './stackImagePins';
import { persistDebugLog } from '../../persistDebugLog';
import { ComposeTimeline } from './composeTimeline';
import { ensureHermesWebuiSyncToInsights } from './hermes/hermesWebuiSync';
import { activeAssistantStackIdentity } from './assistantStackIdentity';
import {
  getAppliedCodingAliases,
  recordAppliedCodingAliases,
  recordHermesCodingRoots,
} from './coding/codingGrantStore';
import { codingStackEnv, currentCodingPathAliases, currentCodingRoots } from './coding/codingMounts';
import {
  ensureHostBridgeStarted,
  hostBridgeWakeAccepted,
  type HostBridgeEndpoints,
} from '../hostBridge/hostBridgeService';
import {
  ensureHostBridgeToken,
  getHostBridgeBrowserSettings,
  isHostBridgeAgentStopped,
} from '../hostBridge/hostBridgeStore';
import { wakeHermesBridgeServer } from '../hostBridge/hermesWake';
import { resolveApiServerKey, resolveHermesStackEndpoints } from './hermes/hermesEndpoints';
import {
  hostBridgeCdpUrl,
  hostBridgeHermesConfigSets,
  writeHostBridgeTokensToProfiles,
} from '../hostBridge/hermesProvision';
import {
  ensureProjectMountPoints,
  hermesProjectsOverlayExists,
  writeHermesProjectsOverlay,
  resolveHermesProjectsOverlayPath,
} from './hermes/hermesProjectsOverlay';
import { holdFolderRemounts, recordMountedProjectFolders } from './hermes/projectMountState';
import { localTerminalService } from './hermes/hermesContextRoots';

export type AssistantStackLifecycleCallback = (
  snapshot: AssistantStackLifecycleSnapshot
) => void;

let lifecycleCallback: AssistantStackLifecycleCallback | null = null;
let lifecycleSnapshot: AssistantStackLifecycleSnapshot = createLifecycleSnapshot('idle');
/** Single-flight for ensure so background + setup step share one bring-up. */
let ensureRunningPromise: Promise<EnsureAssistantStackResult> | null = null;

export function setAssistantStackLifecycleCallback(
  callback: AssistantStackLifecycleCallback | null
): void {
  lifecycleCallback = callback;
}

// The last readiness a check saw, so a change reaches the renderer without it polling.
let lastReady: boolean | null = null;
let readyCallback: ((ready: boolean) => void) | null = null;

export function setAssistantStackReadyCallback(callback: ((ready: boolean) => void) | null): void {
  readyCallback = callback;
}

export function getAssistantStackLifecycle(): AssistantStackLifecycleSnapshot {
  return lifecycleSnapshot;
}

/**
 * Notify renderer that quit has begun before teardown work runs. A local stack is left
 * running, so there is nothing to wait on and no quit overlay to show.
 */
export function announceAssistantStackStopping(): void {
  if (isLocalAssistantStackMode()) return;
  setLifecycle(
    createLifecycleSnapshot('stopping', {
      message: 'Quit requested — stopping assistant containers…',
      services: seedServiceProgress('working', 'Stopping…', 0.15),
    })
  );
}

function emitProgress(message: string): void {
  if (lifecycleSnapshot.message !== message) {
    setLifecycle({ ...lifecycleSnapshot, message });
  } else {
    setLifecycle({ ...lifecycleSnapshot, updatedAt: Date.now() });
  }
}

function emitStage(
  stage: AssistantStackLifecycleStage,
  message: string,
  options?: { services?: AssistantStackServiceProgress[] }
): void {
  const now = Date.now();
  const stageChanged = lifecycleSnapshot.stage !== stage;
  setLifecycle({
    ...lifecycleSnapshot,
    phase:
      lifecycleSnapshot.phase === 'idle' || lifecycleSnapshot.phase === 'stopped'
        ? 'starting'
        : lifecycleSnapshot.phase === 'ready' && stage !== 'ready'
          ? 'starting'
          : lifecycleSnapshot.phase,
    stage,
    stageStartedAt: stageChanged ? now : (lifecycleSnapshot.stageStartedAt ?? now),
    message,
    ...(options?.services ? { services: options.services } : {}),
  });
}

/**
 * One debug-log line per finished start-up stage, to tune the start-up screen's
 * progress curves (ADR 0029) from real runs.
 */
function logStageTiming(
  prev: AssistantStackLifecycleSnapshot,
  next: AssistantStackLifecycleSnapshot
): void {
  if (!prev.stage || !prev.stageStartedAt || prev.phase !== 'starting') return;
  if (next.stage === undefined || next.stage === prev.stage) return;
  persistDebugLog('assistant-stack', 'start-up stage finished', {
    stage: prev.stage,
    next: next.stage,
    ms: Date.now() - prev.stageStartedAt,
    firstRun: startIsFirstRun,
    ...(prev.download ? { downloadedBytes: prev.download.receivedBytes } : {}),
  });
}

function setLifecycle(snapshot: AssistantStackLifecycleSnapshot): void {
  const prev = lifecycleSnapshot;
  const reset = isLifecycleWaveBoundary(prev.phase, snapshot.phase);
  const services =
    reset || prev.services.length === 0
      ? snapshot.services
      : mergeServicesById(prev.services, snapshot.services, `setLifecycle:${prev.phase}→${snapshot.phase}`);
  const stageChanged =
    snapshot.stage !== undefined && snapshot.stage !== prev.stage;
  logStageTiming(prev, snapshot);
  lifecycleSnapshot = {
    ...snapshot,
    services,
    updatedAt: snapshot.updatedAt ?? Date.now(),
    stageStartedAt: stageChanged
      ? (snapshot.stageStartedAt ?? Date.now())
      : (snapshot.stageStartedAt ?? prev.stageStartedAt),
    stage: snapshot.stage ?? prev.stage,
  };
  lifecycleCallback?.(lifecycleSnapshot);
}

function markAllServicesDone(
  services: AssistantStackServiceProgress[],
  statusText: string
): AssistantStackServiceProgress[] {
  return services.map((service) =>
    mergeServiceProgress(
      service,
      {
        state: 'done',
        statusText,
        progress: 1,
      },
      `markAllDone:${service.containerName}`
    )
  );
}

/** Layer bytes for the current start; reset when an ensure begins. */
let downloadTally: DownloadTally = {};
/** Whether the current start includes host setup, for the stage-timing log. */
let startIsFirstRun = false;

function handleProgressLine(line: string): void {
  const event = parseComposeProgressLine(line);
  if (!event) return;
  const nextServices = applyComposeProgressEvent(lifecycleSnapshot.services, event);
  const nextTally = tallyDownload(downloadTally, event);
  if (nextServices === lifecycleSnapshot.services && nextTally === downloadTally) return;
  downloadTally = nextTally;
  setLifecycle({
    ...lifecycleSnapshot,
    services: nextServices,
    download: summarizeDownload(downloadTally),
  });
}

function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function arePortsAvailable(ports: AssistantStackPorts): Promise<boolean> {
  const values = Object.values(ports);
  const checks = await Promise.all(values.map((port) => isPortFree(port)));
  return checks.every(Boolean);
}

export async function resolveAssistantPorts(options?: {
  preferStored?: boolean;
}): Promise<{ ports: AssistantStackPorts; isolationMode: AssistantStackIsolationMode }> {
  if (options?.preferStored && isAssistantStackSetupComplete()) {
    return {
      ports: getStoredAssistantPorts(),
      isolationMode: getStoredIsolationMode(),
    };
  }

  const defaults = { ...DEFAULT_ASSISTANT_STACK_PORTS };
  // A separate instance stays off the defaults, which the default build may claim later.
  if (!IS_SEPARATE_INSTANCE && (await arePortsAvailable(defaults))) {
    return { ports: defaults, isolationMode: 'default-ports' };
  }

  const offset = portsForIsolationMode('offset-ports');
  if (await arePortsAvailable(offset)) {
    return { ports: offset, isolationMode: 'offset-ports' };
  }

  // Fall back to stored/default even if busy — compose will surface the bind error.
  return { ports: getStoredAssistantPorts(), isolationMode: getStoredIsolationMode() };
}

function portsToComposeEnv(ports: AssistantStackPorts): NodeJS.ProcessEnv {
  // Host publish ports may be offset for dual-stack. Most of the stack's port variables are
  // host-only (v0.2.0+), so Boundary sets them directly. HERMES_*_PORT and LightRAG's PORT
  // are also read inside the container (bootstrap writes API_SERVER_PORT from
  // HERMES_API_SERVER_PORT), so they stay at the defaults and the overlay publishes
  // BOUNDARY_*_HOST_PORT instead.
  return {
    SEARXNG_PORT: String(ports.searxng),
    HERMES_WEBUI_PORT: String(ports.webui),
    NEO4J_HTTP_HOST_PORT: String(ports.neo4jHttp),
    NEO4J_BOLT_HOST_PORT: String(ports.neo4jBolt),
    OPENCODE_PORT: String(ports.opencode),
    GPTR_PORT: String(ports.gptResearcher),
    N8N_HOST_PORT: String(ports.n8n),
    LLM_PROXY_ADMIN_PORT: String(ports.llmProxyAdmin),
    BOUNDARY_HERMES_GATEWAY_HOST_PORT: String(ports.gateway),
    BOUNDARY_HERMES_API_HOST_PORT: String(ports.apiServer),
    BOUNDARY_HERMES_DASHBOARD_HOST_PORT: String(ports.dashboard),
    BOUNDARY_LIGHTRAG_HOST_PORT: String(ports.lightrag),
    HERMES_GATEWAY_PORT: String(DEFAULT_ASSISTANT_STACK_PORTS.gateway),
    HERMES_API_SERVER_PORT: String(DEFAULT_ASSISTANT_STACK_PORTS.apiServer),
    HERMES_DASHBOARD_PORT: String(DEFAULT_ASSISTANT_STACK_PORTS.dashboard),
  };
}

function buildComposeFileArgs(overlayPath: string): string[] {
  const args = ['-f', BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE, '-f', overlayPath];
  if (hermesProjectsOverlayExists()) {
    args.push('-f', resolveHermesProjectsOverlayPath());
  }
  return args;
}

function buildProjectArgs(overlayPath: string): string[] {
  return ['-p', BOUNDARY_ASSISTANT_PROJECT_NAME, ...buildComposeFileArgs(overlayPath)];
}

async function httpGetOk(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export async function waitUntilAssistantHealthy(
  ports: AssistantStackPorts,
  timeoutMs = ASSISTANT_STACK_HEALTH_TIMEOUT_MS
): Promise<void> {
  const healthUrl = `http://127.0.0.1:${ports.apiServer}/health`;
  const deadline = Date.now() + timeoutMs;
  const waitStarted = Date.now();
  // Keep checklist honest when health runs after configureLlm (post-restart).
  if (lifecycleSnapshot.stage !== 'health' && lifecycleSnapshot.phase !== 'ready') {
    emitStage('health', 'Waiting for Hermes health check…');
  }
  while (Date.now() < deadline) {
    if (await httpGetOk(healthUrl)) {
      return;
    }
    const elapsedSec = Math.floor((Date.now() - waitStarted) / 1000);
    emitProgress(
      elapsedSec > 0
        ? `Waiting for Hermes API to become healthy… ${elapsedSec}s`
        : 'Waiting for Hermes API to become healthy…'
    );
    const hermes = lifecycleSnapshot.services.find((s) => s.containerName === 'boundary-hermes');
    if (hermes && hermes.state !== 'done') {
      setLifecycle({
        ...lifecycleSnapshot,
        services: lifecycleSnapshot.services.map((s) =>
          s.containerName === 'boundary-hermes'
            ? mergeServiceProgress(
                s,
                {
                  state: 'working',
                  statusText: 'Waiting for health…',
                  progress: Math.max(s.progress, PROGRESS.started),
                },
                'health:hermes'
              )
            : s
        ),
      });
    }
    await new Promise((r) => setTimeout(r, ASSISTANT_STACK_HEALTH_INTERVAL_MS));
  }
  throw new Error(`Hermes API did not become healthy at ${healthUrl} within ${timeoutMs}ms`);
}

export function buildAssistantStackStatus(partial?: {
  ready?: boolean;
  lastError?: string;
}): AssistantStackStatus {
  const { root, error } = tryResolveAssistantRoot();
  let overlayPath: string | null;
  try {
    overlayPath = resolveBoundaryOverlayPath();
  } catch {
    overlayPath = null;
  }

  const ports = getStoredAssistantPorts();
  const isolationMode = getStoredIsolationMode();

  return {
    projectName: BOUNDARY_ASSISTANT_PROJECT_NAME,
    assistantRoot: root,
    assistantRootError: error,
    stack: activeAssistantStackIdentity(),
    dataDir: (() => {
      try {
        return root ? resolveAssistantDataRoot(root) : resolveAssistantDataRoot();
      } catch {
        return null;
      }
    })(),
    overlayPath,
    ports,
    isolationMode,
    apiBaseUrl: `http://127.0.0.1:${ports.apiServer}/v1`,
    healthUrl: `http://127.0.0.1:${ports.apiServer}/health`,
    setupComplete: isAssistantStackSetupComplete(),
    ready: Boolean(partial?.ready),
    lastError: partial?.lastError,
    uiServices: buildAssistantUiServiceCards(ports),
  };
}

export async function isAssistantStackReady(): Promise<boolean> {
  const ports = getStoredAssistantPorts();
  const ready = await httpGetOk(`http://127.0.0.1:${ports.apiServer}/health`);
  if (ready !== lastReady) {
    lastReady = ready;
    readyCallback?.(ready);
  }
  return ready;
}

export async function getAssistantStackStatus(): Promise<AssistantStackStatus> {
  const ready = await isAssistantStackReady();
  return buildAssistantStackStatus({ ready });
}

function hostUidGidEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (typeof process.getuid === 'function') {
    env.HERMES_UID = String(process.getuid());
  }
  if (typeof process.getgid === 'function') {
    env.HERMES_GID = String(process.getgid());
  }
  return env;
}

async function buildBoundaryComposeContext(options: {
  openCodeConfigFile?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{
  root: string;
  overlayPath: string;
  runtime: Awaited<ReturnType<typeof getContainerRuntime>>;
  env: NodeJS.ProcessEnv;
  projectArgs: string[];
}> {
  const { root, error } = tryResolveAssistantRoot();
  if (!root) {
    throw new Error(error ?? 'Assistant root not found');
  }
  const overlayPath = resolveBoundaryOverlayPath();
  const dataRoot = resolveAssistantDataRoot(root);
  const workspaceRoot = options.workspaceRoot ?? resolveAssistantWorkspaceRoot();
  const openCodeConfigFile =
    options.openCodeConfigFile ?? (await ensureOpenCodeConfigFile(root, dataRoot));
  const runtime = await getContainerRuntime();
  const ports = getStoredAssistantPorts();
  return {
    root,
    overlayPath,
    runtime,
    projectArgs: buildProjectArgs(overlayPath),
    env: {
      ...portsToComposeEnv(ports),
      ...hostUidGidEnv(),
      BOUNDARY_ASSISTANT_DATA: dataRoot,
      // Shell, file and execute_code tools run in hermes-worker over ssh, which holds no
      // secrets; upstream's terminal-ssh.yml puts the workspace mounts there.
      HERMES_TERMINAL_BACKEND: BOUNDARY_HERMES_TERMINAL_BACKEND,
      // A second copy beside a developer stack (the stack's docs/extending.md).
      CONTAINER_PREFIX: BOUNDARY_ASSISTANT_CONTAINER_PREFIX,
      IMAGE_PREFIX: BOUNDARY_ASSISTANT_IMAGE_PREFIX,
      BOUNDARY_OPENCODE_WORKSPACE: workspaceRoot,
      BOUNDARY_OPENCODE_CONFIG_FILE: openCodeConfigFile,
      // Still set OPENCODE_WORKSPACE_HOST for any base-compose references.
      OPENCODE_WORKSPACE_HOST: workspaceRoot,
      // Coding folders (ADR 0028 §4, change request 0003): opencode-mcp's allowlist, Hermes's
      // write-safe root, "the app will ask" for coding and context roots, and project aliases.
      ...codingStackEnv(),
      COMPOSE_PROFILES: boundaryComposeProfilesCsv(),
      // The Hermes bootstraps register the shared database's SQL MCP. setup.sh --db writes
      // this into .env, but an install already on the pinned tag doesn't re-run setup.
      SQL_MCP_ENABLED: '1',
      // The overlay gives this to caldav-mcp only (calendar spec, Phase 0 S7).
      BOUNDARY_CALDAV_TZ: hostTimeZone(),
      ...options.env,
    },
  };
}

async function runBoundaryCompose(
  args: string[],
  options: {
    timeout?: number;
    env?: NodeJS.ProcessEnv;
    openCodeConfigFile?: string;
    workspaceRoot?: string;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  const ctx = await buildBoundaryComposeContext(options);
  return runCompose(ctx.runtime, [...ctx.projectArgs, ...args], {
    cwd: ctx.root,
    timeout: options.timeout,
    env: ctx.env,
  });
}

/**
 * Stream Compose with `--progress=json`. Until the first JSON event moves a card, `ps` is
 * polled every 1.5 s so the cards still advance; the events take over from there. Boundary
 * requires a Compose that has `--progress json` (2.29.1, assistantStackRequirements.ts).
 */
async function runBoundaryComposeWithProgress(
  args: string[],
  options: {
    timeout?: number;
    env?: NodeJS.ProcessEnv;
    openCodeConfigFile?: string;
    workspaceRoot?: string;
    pollPs?: boolean;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  const ctx = await buildBoundaryComposeContext(options);
  const composeArgs = ['--progress', 'json', ...ctx.projectArgs, ...args];
  const isUp = args.includes('up');

  if (isUp) {
    await primeLocalImageProgress(ctx.runtime);
  }

  let sawJsonProgress = false;
  const startedAt = Date.now();
  const timeline = new ComposeTimeline(startedAt);
  // Filled in as the run ends; logged once in `finally`.
  const outcome: { code?: number | null; timedOut?: boolean; error?: string } = {};
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const onLine = (line: string) => {
    const event = parseComposeProgressLine(line);
    if (event) timeline.record(event);
    const before = lifecycleSnapshot.services;
    handleProgressLine(line);
    if (lifecycleSnapshot.services !== before) {
      sawJsonProgress = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    }
  };

  if (options.pollPs !== false) {
    pollTimer = setInterval(() => {
      void reconcileFromComposePs(ctx).catch(() => {
        /* best-effort */
      });
    }, 1_500);
  }

  try {
    const result = await runComposeStreaming(ctx.runtime, composeArgs, {
      cwd: ctx.root,
      timeout: options.timeout,
      env: ctx.env,
      onStdoutLine: onLine,
      onStderrLine: onLine,
    });
    outcome.code = result.code;
    outcome.timedOut = result.timedOut;

    if (result.timedOut) {
      const detail = (result.stderr || result.stdout || '').trim().slice(-2_000);
      throw new Error(
        `Compose timed out after ${Math.round((options.timeout ?? 0) / 60_000)} minutes${
          detail ? `: ${detail}` : ''
        }`
      );
    }

    if (result.code !== 0 && result.code != null) {
      const detail = (result.stderr || result.stdout || '').trim().slice(-2_000);
      let bootstrapLogs = '';
      if (/hermes-api-bootstrap/i.test(detail)) {
        bootstrapLogs = await collectHermesBootstrapLogs(ctx).catch(() => '');
      }
      throw new Error(
        `Compose exited with code ${result.code}${detail ? `: ${detail}` : ''}${
          bootstrapLogs ? `\n\n--- hermes-api-bootstrap logs ---\n${bootstrapLogs}` : ''
        }`
      );
    }

    if (!sawJsonProgress) {
      await reconcileFromComposePs(ctx);
    }

    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    outcome.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    throw error;
  } finally {
    if (pollTimer) clearInterval(pollTimer);
    persistDebugLog('assistant-stack', 'compose finished', {
      args,
      timeoutMs: options.timeout,
      ms: Date.now() - startedAt,
      firstRun: startIsFirstRun,
      ...outcome,
      services: timeline.summary(),
    });
  }
}

async function collectHermesBootstrapLogs(ctx: {
  root: string;
  runtime: Awaited<ReturnType<typeof getContainerRuntime>>;
  env: NodeJS.ProcessEnv;
  projectArgs: string[];
}): Promise<string> {
  const { stdout, stderr } = await runCompose(
    ctx.runtime,
    [
      ...ctx.projectArgs,
      ...buildComposeProfileArgs(),
      'logs',
      '--no-color',
      '--tail',
      '120',
      'hermes-api-bootstrap',
    ],
    { cwd: ctx.root, timeout: 30_000, env: ctx.env }
  );
  return (stdout || stderr || '').trim().slice(-2_000);
}

/** Best-effort: mark cards Image ready when the image is already on the host. */
async function primeLocalImageProgress(
  runtime: Awaited<ReturnType<typeof getContainerRuntime>>
): Promise<void> {
  try {
    const { stdout } = await runCli(
      runtime,
      ['images', '--format', '{{.Repository}}:{{.Tag}}'],
      { timeout: 20_000 }
    );
    const lines = stdout.split('\n');
    const next = applyLocalImageListing(lifecycleSnapshot.services, lines);
    setLifecycle({
      ...lifecycleSnapshot,
      services: next,
      message: lifecycleSnapshot.message ?? 'Starting assistant services…',
    });
  } catch {
    // Best effort: without the listing, cards fill from pull progress instead.
  }
}

async function reconcileFromComposePs(ctx: {
  root: string;
  runtime: Awaited<ReturnType<typeof getContainerRuntime>>;
  env: NodeJS.ProcessEnv;
  projectArgs: string[];
}): Promise<void> {
  try {
    const { stdout } = await runCompose(
      ctx.runtime,
      [...ctx.projectArgs, ...buildComposeProfileArgs(), 'ps', '-a', '--format', 'json'],
      { cwd: ctx.root, timeout: 30_000, env: ctx.env }
    );
    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    let services = lifecycleSnapshot.services;
    for (const line of lines) {
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Some compose versions emit a single JSON array.
        try {
          const arr = JSON.parse(stdout) as Array<Record<string, unknown>>;
          for (const item of arr) {
            services = applyPsRow(services, item);
          }
          setLifecycle({ ...lifecycleSnapshot, services });
          return;
        } catch {
          continue;
        }
      }
      services = applyPsRow(services, row);
    }
    setLifecycle({ ...lifecycleSnapshot, services });
  } catch {
    /* ignore poll failures */
  }
}

function applyPsRow(
  services: AssistantStackServiceProgress[],
  row: Record<string, unknown>
): AssistantStackServiceProgress[] {
  const name =
    (typeof row.Name === 'string' && row.Name) ||
    (typeof row.name === 'string' && row.name) ||
    (typeof row.Service === 'string' && row.Service) ||
    (typeof row.service === 'string' && row.service) ||
    '';
  const container = resolveContainerFromProgressId(name);
  if (!container) return services;

  // `State` is the bare state ("running"); the health check's result is in `Health`, and in
  // `Status` ("Up 2 minutes (healthy)"). `Health` is empty for a service without a check.
  const stateRaw = String(
    row.Health || row.health || row.Status || row.status || row.State || row.state || ''
  ).toLowerCase();
  let text = 'Updating…';
  let progress = 0.55;
  let state: AssistantStackServiceProgress['state'] = 'working';

  if (/\bhealthy\b/.test(stateRaw)) {
    text = 'Healthy';
    progress = PROGRESS.healthy;
    state = 'done';
  } else if (stateRaw.includes('running') || stateRaw.includes('up')) {
    text = 'Started';
    progress = PROGRESS.started;
    state = 'working';
  } else if (stateRaw.includes('exited') || stateRaw.includes('stopped')) {
    text = lifecycleSnapshot.phase === 'stopping' ? 'Stopped' : 'Exited';
    progress = lifecycleSnapshot.phase === 'stopping' ? PROGRESS.stopped : 0.3;
    state = lifecycleSnapshot.phase === 'stopping' ? 'done' : 'working';
  } else if (stateRaw.includes('created')) {
    text = 'Created';
    progress = PROGRESS.created;
    state = 'working';
  } else if (stateRaw.includes('restarting') || stateRaw.includes('starting')) {
    text = 'Starting…';
    progress = PROGRESS.starting;
    state = 'working';
  }

  return services.map((s) => {
    if (s.containerName !== container) return s;
    if (s.state === 'done' && state === 'working') return s;
    return mergeServiceProgress(
      s,
      {
        state,
        statusText: text,
        progress,
      },
      `ps:${container}`
    );
  });
}

/**
 * Stop and remove Boundary's stack containers before its tree is replaced, so nothing
 * keeps writing into data/ while it moves. Goes by the Compose project label rather than
 * the compose files, which may not parse with the old tree and the new overlay together.
 */
async function stopBoundaryContainersForUpgrade(): Promise<void> {
  const runtime = await getContainerRuntime();
  const { stdout } = await runCli(
    runtime,
    ['ps', '-aq', '--filter', `label=com.docker.compose.project=${BOUNDARY_ASSISTANT_PROJECT_NAME}`],
    { timeout: 30_000 }
  );
  const ids = stdout.split(/\s+/).filter(Boolean);
  if (ids.length === 0) return;
  await runCli(runtime, ['stop', '-t', '10', ...ids], { timeout: ASSISTANT_STACK_DOWN_TIMEOUT_MS });
  await runCli(runtime, ['rm', '-f', ...ids], { timeout: 60_000 });
}

/**
 * Write Boundary's HERMES_TERMINAL_BACKEND into .env. Compose gets it from the process
 * environment either way; this keeps the stack's own scripts in step.
 */
async function pinTerminalBackendInProjectEnv(root: string): Promise<void> {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  const contents = await fs.promises.readFile(envPath, 'utf8');
  const next = upsertEnvLines(contents, { HERMES_TERMINAL_BACKEND: BOUNDARY_HERMES_TERMINAL_BACKEND });
  if (next !== contents) await fs.promises.writeFile(envPath, next, 'utf8');
}

/** Best-effort prune of dangling volumes labeled for this Compose project. */
async function pruneBoundaryAssistantVolumes(): Promise<void> {
  try {
    const runtime = await getContainerRuntime();
    await runCli(
      runtime,
      [
        'volume',
        'prune',
        '--filter',
        `label=com.docker.compose.project=${BOUNDARY_ASSISTANT_PROJECT_NAME}`,
        '-f',
      ],
      { timeout: 60_000 }
    );
  } catch {
    /* must not block quit */
  }
}

/**
 * First-boot Hermes home: non-interactive setup + drop stub gateway profiles so
 * hermes-api-bootstrap can clone them cleanly.
 *
 * Bare `hermes setup --non-interactive` exits 0 without writing config.yaml when
 * there is no TTY (Docker `compose run`). `--reset` materializes defaults; safe
 * only for Boundary-owned userData installs — never against a local checkout.
 */
async function prepareHermesHome(dataRoot: string): Promise<void> {
  const localMode = isLocalAssistantStackMode();
  if (!localMode) {
    await removeIncompleteHermesProfiles(dataRoot);
  }

  if (hermesConfigExists(dataRoot)) {
    return;
  }

  if (localMode) {
    throw new Error(
      'Hermes config.yaml is missing under the local assistant data directory. ' +
        'Run setup from your sovereign-agent-stack checkout (or start the stack there) ' +
        `before using bun run dev:local-stack. ${APP_NAME} will not run hermes setup --reset ` +
        'against a local checkout.'
    );
  }

  const hermesServices = lifecycleSnapshot.services.map((s) =>
    s.containerName === 'boundary-hermes'
      ? mergeServiceProgress(
          s,
          {
            state: 'working',
            statusText: 'Configuring…',
            progress: Math.max(s.progress, 0.35),
          },
          'hermesInit:configuring'
        )
      : s
  );
  emitStage('hermesInit', 'Initializing Hermes (non-interactive reset)…', {
    services: hermesServices,
  });

  const stopHeartbeat = startElapsedHeartbeat(
    (message) => emitProgress(message),
    'Initializing Hermes'
  );
  try {
    await runBoundaryCompose(
      [
        '--profile',
        BOUNDARY_ASSISTANT_COMPOSE_PROFILE,
        'run',
        '--rm',
        '--no-deps',
        '--entrypoint',
        'hermes',
        'hermes',
        'setup',
        '--non-interactive',
        '--reset',
      ],
      { timeout: 180_000 }
    );
  } finally {
    stopHeartbeat();
  }

  // Drop anonymous volumes left by the one-shot setup container.
  emitProgress('Cleaning up setup volumes…');
  await pruneBoundaryAssistantVolumes();

  if (!hermesConfigExists(dataRoot)) {
    throw new Error(
      `Hermes setup did not create config.yaml under ${APP_NAME} assistant data. Re-run Setup or reset the assistant stack and try again.`
    );
  }
}

/** Compose projects outside Boundary's own with running containers from the local checkout. */
async function findLiveForeignProjects(): Promise<{ root: string; projects: string[] }> {
  const { root } = tryResolveAssistantRoot();
  if (!root) return { root: '', projects: [] };
  try {
    const runtime = await getContainerRuntime();
    const { stdout } = await runCli(runtime, LIVE_STACK_PS_ARGS, { timeout: 30_000 });
    return { root, projects: liveForeignProjectsAt(root, stdout) };
  } catch {
    return { root, projects: [] };
  }
}

/**
 * When local-stack mode is on and Hermes already answers on default ports,
 * attach without compose up / down (developer `make up` stack).
 * Requires {@link StackMode.attachLive}: a local root plus BOUNDARY_LOCAL_STACK=1.
 *
 * If Hermes isn't answering yet but the checkout's own Compose project has running
 * containers (a `make up` still starting, or one whose Hermes is down), wait for it rather
 * than starting `boundary-assistant` beside it: both bind the same host ports. Throws when
 * that stack doesn't become healthy in time.
 */
async function tryAttachToLiveLocalStack(): Promise<boolean> {
  if (!stackMode().attachLive) {
    return false;
  }
  const defaults = { ...DEFAULT_ASSISTANT_STACK_PORTS };
  const healthUrl = `http://127.0.0.1:${defaults.apiServer}/health`;
  if (!(await httpGetOk(healthUrl))) {
    const { root, projects } = await findLiveForeignProjects();
    if (projects.length === 0) {
      return false;
    }
    const names = projects.join(', ');
    emitStage(
      'health',
      `Waiting for the running local stack (Compose project ${names}) to finish starting…`
    );
    try {
      await waitUntilAssistantHealthy(defaults, LIVE_LOCAL_STACK_START_TIMEOUT_MS);
    } catch {
      throw new Error(
        `Compose project ${names} in ${root} is running, but Hermes did not answer on ` +
          `${healthUrl} within ${LIVE_LOCAL_STACK_START_TIMEOUT_MS / 60_000} minutes. ` +
          `${APP_NAME} will not start a second copy beside it, since both use the same ports. ` +
          `Fix that stack's Hermes, or stop it (make down in ${root}) and relaunch.`
      );
    }
  }
  setStoredAssistantPorts(defaults, 'default-ports');
  emitProgress('Attached to live local assistant stack on default ports.');
  setLifecycle(
    createLifecycleSnapshot('ready', {
      message: 'Attached to live local assistant stack.',
      stage: 'ready',
      services: markStackReadyAfterEnsure(
        markAllServicesDone(seedServiceProgress(), 'Ready')
      ),
    })
  );
  return true;
}

/**
 * Bring up the Boundary-managed assistant stack (core+rag+automation+coding).
 * First launch: download pinned sovereign-agent-stack, run upstream setup.sh, then compose up.
 * Concurrent callers share one in-flight promise (background early-start + setup step).
 */
export async function ensureAssistantStackRunning(): Promise<EnsureAssistantStackResult> {
  if (ensureRunningPromise) {
    return ensureRunningPromise;
  }
  ensureRunningPromise = ensureAssistantStackRunningImpl().finally(() => {
    ensureRunningPromise = null;
  });
  return ensureRunningPromise;
}

/**
 * Fire-and-forget ensure for onboarding overlap (after capability). Errors surface via lifecycle.
 */
export function ensureAssistantStackRunningInBackground(): void {
  void ensureAssistantStackRunning();
}

async function ensureAssistantStackRunningImpl(): Promise<EnsureAssistantStackResult> {
  downloadTally = {};
  startIsFirstRun = !isHostSetupComplete();
  // Set once this start holds the folder remount queue; released when the start ends.
  let releaseRemounts: (() => void) | null = null;
  try {
    setLifecycle(
      createLifecycleSnapshot('starting', {
        message: 'Preparing assistant stack…',
        stage: 'provision',
        services: seedServiceProgress('pending', 'Waiting…', 0),
      })
    );

    if (await tryAttachToLiveLocalStack()) {
      const status = buildAssistantStackStatus({ ready: true });
      return { success: true, status };
    }

    if (stackMode().kind === 'managed') {
      emitStage('provision', `Provisioning ${APP_NAME}-managed agent stack…`);
      await ensureSovereignProjectProvisioned({
        onProgress: emitProgress,
        beforeReplace: stopBoundaryContainersForUpgrade,
      });
    }

    const { root, error } = tryResolveAssistantRoot();
    if (!root) {
      setLifecycle(
        createLifecycleSnapshot('error', {
          message: error,
          error,
          stage: 'error',
        })
      );
      return {
        success: false,
        status: buildAssistantStackStatus({ ready: false, lastError: error }),
        error,
      };
    }

    const dataRoot = resolveAssistantDataRoot(root);
    const workspaceRoot = resolveAssistantWorkspaceRoot();
    await ensureAssistantWorkspaceDir(workspaceRoot);

    const hostSetupComplete = isHostSetupComplete();
    const boundaryOwned = isBoundaryOwnedAssistantRoot(root);

    if (!hostSetupComplete && boundaryOwned) {
      const runtime = await getContainerRuntime();
      const setupEnv: NodeJS.ProcessEnv = {
        ...runtime.env,
        ...(process.env.BOUNDARY_EMULATE_NO_DOCKER === '1'
          ? { BOUNDARY_EMULATE_NO_DOCKER: '1' }
          : {}),
      };
      emitStage(
        'hostSetup',
        'Running sovereign-agent-stack setup.sh (secrets, data/, profiles)…'
      );
      persistDebugLog('assistant-stack', 'about to runSovereignSetup', {
        root,
        hostSetupComplete,
        boundaryOwned,
      });
      await runSovereignSetup({
        projectRoot: root,
        workspaceRoot,
        onProgress: emitProgress,
        env: setupEnv,
      });
      await pinTerminalBackendInProjectEnv(root);
      if (await syncStackImagePins(root)) {
        emitProgress('Moved the agent stack’s image pins to this version.');
      }
      await markHostSetupComplete();
      const llmForEnv = await getLlmConnection();
      if (llmForEnv?.endpointUrl && llmForEnv.apiKey && llmForEnv.modelId) {
        emitProgress(`Writing ${APP_NAME} LLM settings into project .env…`);
        await applyLlmConnectionToProjectFiles(root, llmForEnv);
      }
    }

    // Earlier Boundary versions wrote the real key into .env. The proxy now gets it through
    // its admin API, so a proxy created from an old .env must be recreated to drop it.
    const proxyHasStaleKey = boundaryOwned && (await clearLlmKeysFromProjectEnv(root));

    // Host folders in the overlay the coming `up` reads; null when there's no overlay.
    let overlayHostPaths: string[] | null = null;
    if (boundaryOwned) {
      // Wait out any queued remount, then keep remounts off until `up` is done with the overlay.
      releaseRemounts = await holdFolderRemounts();
      // A file written by an older Boundary may restate mounts this stack no longer has.
      const projects = listStoredHermesProjects();
      writeHermesProjectsOverlay(projects);
      overlayHostPaths = projects
        .filter((project) => project.kind === 'host-folder')
        .map((project) => project.hostPath);
      ensureProjectMountPoints(projects, path.join(resolveAssistantUserContentRoot(root), 'projects'));
      if (await ensureHermesWorkerKey(root)) {
        emitProgress('Created a new SSH key for the tool worker.');
      }
    }

    emitProgress(`Preparing ${APP_NAME} assistant data directory…`);
    await ensureAssistantDataDirs(dataRoot);
    ensureHermesWebuiSyncToInsights(dataRoot);
    const openCodeConfigFile = await ensureOpenCodeConfigFile(root, dataRoot);

    const preferStored = isAssistantStackSetupComplete();
    const { ports, isolationMode } = await resolveAssistantPorts({ preferStored });
    setStoredAssistantPorts(ports, isolationMode);

    if (await isAssistantStackReady()) {
      if (proxyHasStaleKey) {
        emitProgress('Recreating the model proxy without the key in its environment…');
        await runBoundaryCompose(
          [...buildComposeProfileArgs(), 'up', '-d', '--no-deps', 'llm-proxy'],
          { timeout: 120_000, openCodeConfigFile, workspaceRoot }
        );
      }
      emitProgress('Assistant stack already healthy.');
      // Re-assert WebUI → state.db projection for already-running stacks.
      ensureHermesWebuiSyncToInsights(dataRoot);
      setLifecycle(
        createLifecycleSnapshot('ready', {
          message: 'Assistant stack already healthy.',
          stage: 'ready',
          services: markStackReadyAfterEnsure(
            markAllServicesDone(seedServiceProgress(), 'Ready')
          ),
        })
      );
      const status = buildAssistantStackStatus({ ready: true });
      return { success: true, status };
    }

    const startMessage =
      isolationMode === 'offset-ports'
        ? `Starting assistant services on offset ports (API ${ports.apiServer})…`
        : `Starting assistant services (${BOUNDARY_ASSISTANT_COMPOSE_PROFILES.join(', ')})…`;

    await prepareHermesHome(dataRoot);

    // Stub profile dirs (e.g. only memories/) make hermes-api-bootstrap skip
    // --clone and then exit 1 on set_yaml_list. Clean again immediately before up, on
    // Boundary's own install only, as prepareHermesHome does.
    if (!isLocalAssistantStackMode()) await removeIncompleteHermesProfiles(dataRoot);

    // After a pin change, rebuild the stack's local images once (stack CHANGELOG upgrade
    // steps). Unchanged images come from the build cache.
    const buildImages = boundaryOwned && needsImageBuild();
    if (buildImages) emitProgress('Building the agent stack’s local images for this version…');

    emitStage('compose', startMessage);
    await runBoundaryComposeWithProgress(
      [...buildComposeProfileArgs(), 'up', '-d', ...(buildImages ? ['--build'] : [])],
      {
        timeout: buildImages ? ASSISTANT_STACK_BUILD_UP_TIMEOUT_MS : ASSISTANT_STACK_UP_TIMEOUT_MS,
        openCodeConfigFile,
        workspaceRoot,
      }
    );

    emitStage('health', 'Waiting for Hermes health check…');
    await waitUntilAssistantHealthy(ports);
    // `up` recreates hermes and opencode-mcp whenever their coding variables changed.
    recordHermesCodingRoots(currentCodingRoots());
    if (overlayHostPaths) recordMountedProjectFolders(overlayHostPaths);
    recordAppliedCodingAliases(currentCodingPathAliases());
    if (buildImages) await markImagesBuilt();

    const baseServices = lifecycleSnapshot.services.length
      ? lifecycleSnapshot.services
      : seedServiceProgress();
    setLifecycle(
      createLifecycleSnapshot('ready', {
        message: 'Assistant stack is ready.',
        stage: 'ready',
        services: markStackReadyAfterEnsure(baseServices),
      })
    );

    const status = buildAssistantStackStatus({ ready: true });
    return { success: true, status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    persistDebugLog('assistant-stack', 'start-up failed', {
      stage: lifecycleSnapshot.stage,
      firstRun: startIsFirstRun,
      error: message.slice(0, 500),
    });
    setLifecycle(
      createLifecycleSnapshot('error', {
        message,
        error: message,
        stage: 'error',
        services: lifecycleSnapshot.services.map((s) =>
          s.state === 'done' ? s : { ...s, state: 'error' as const, statusText: 'Failed' }
        ),
      })
    );
    return {
      success: false,
      status: buildAssistantStackStatus({ ready: false, lastError: message }),
      error: message,
    };
  } finally {
    releaseRemounts?.();
  }
}

export async function stopAssistantStack(): Promise<StopAssistantStackResult> {
  try {
    if (isLocalAssistantStackMode()) {
      // Leave the lifecycle as it is: 'stopping'/'stopped' put up the quit overlay.
      persistDebugLog('assistant-stack', localStackStopSkippedMessage());
      return { success: true };
    }

    const { root } = tryResolveAssistantRoot();
    if (!root) {
      setLifecycle(
        createLifecycleSnapshot('stopped', {
          message: 'Assistant root not found; nothing to stop.',
          services: markAllServicesDone(seedServiceProgress(), 'Stopped'),
        })
      );
      return { success: true };
    }
    emitProgress(`Stopping ${APP_NAME} assistant stack…`);
    stopKeepingLlmProxyUpstream();
    setLifecycle(
      createLifecycleSnapshot('stopping', {
        message: `Stopping ${APP_NAME} assistant stack…`,
        services: seedServiceProgress('working', 'Stopping…', 0.2),
      })
    );

    await runBoundaryComposeWithProgress(
      [
        ...buildComposeProfileArgs(),
        'down',
        '--timeout',
        '10',
        '--volumes',
        '--remove-orphans',
      ],
      { timeout: ASSISTANT_STACK_DOWN_TIMEOUT_MS }
    );

    await pruneBoundaryAssistantVolumes();

    setLifecycle(
      createLifecycleSnapshot('stopped', {
        message: 'Assistant stack stopped.',
        services: markAllServicesDone(
          lifecycleSnapshot.services.length
            ? lifecycleSnapshot.services
            : seedServiceProgress(),
          'Stopped'
        ),
      })
    );
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLifecycle(
      createLifecycleSnapshot('error', {
        message,
        error: message,
        services: lifecycleSnapshot.services,
      })
    );
    return {
      success: false,
      error: message,
    };
  }
}

export async function restartHermesService(): Promise<void> {
  await runBoundaryCompose(['restart', 'hermes'], { timeout: 120_000 });
}

/**
 * Boundary's Compose profiles, plus `calendar` while a calendar is connected so caldav-mcp starts
 * and stops with the rest of the stack (docs/calendar-ux-study/spec.md).
 */
function boundaryComposeProfilesCsv(): string {
  const profiles: string[] = [...BOUNDARY_ASSISTANT_COMPOSE_PROFILES];
  if (hasCalendarAccounts()) profiles.push(CALENDAR_COMPOSE_PROFILE);
  return profiles.join(',');
}

/** The Mac's IANA zone, e.g. `America/Los_Angeles`; UTC when it can't be read. */
function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function liveLocalStackFileArgs(root: string): string[] {
  const overridePath = path.join(root, 'docker-compose.override.yml');
  const fileArgs = ['-f', BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE];
  if (fs.existsSync(overridePath)) {
    fileArgs.push('-f', overridePath);
  }
  return fileArgs;
}

async function runLiveLocalStackCompose(
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
  const { root, error } = tryResolveAssistantRoot();
  if (!root) {
    throw new Error(error ?? 'Assistant root not found');
  }
  const runtime = await getContainerRuntime();
  const fileArgs = liveLocalStackFileArgs(root);
  return runCompose(runtime, [...fileArgs, ...args], {
    cwd: root,
    timeout: options.timeout,
    env: options.env,
  });
}

/**
 * Recreate Hermes (and WebUI and hermes-worker) so generated host-folder bind mounts take
 * effect. In local-stack mode, `up` the checkout's hermes and terminal service instead, so
 * the context-root binds in its override file apply. Surfaces a short connecting progress
 * message via the lifecycle callback.
 */
/**
 * Compose against the stack this session talks to: the developer's checkout (its own files,
 * no Boundary overlay) in local-stack mode, else Boundary's project.
 */
function activeStackCompose(): HermesConfigCompose {
  return isLocalAssistantStackMode() ? runLiveLocalStackCompose : runBoundaryCompose;
}

export async function recreateHermesForProjectMounts(): Promise<{
  success: boolean;
  error?: string;
}> {
  const aliases = currentCodingPathAliases();
  const aliasesChanged = aliases !== (getAppliedCodingAliases() ?? '');
  try {
    emitProgress('Connecting folder…');
    if (isLocalAssistantStackMode()) {
      // Match sibling `make up`: cwd .env supplies COMPOSE_PROFILES. Extra
      // --profile flags reconcile mail/signal/automation and look like a freeze.
      // Context-root binds sit on the checkout's terminal service, so `up` that too.
      const { root } = tryResolveAssistantRoot();
      const terminal = root ? localTerminalService(root) : 'hermes';
      await runLiveLocalStackCompose(
        ['up', '-d', '--no-deps', 'hermes', ...(terminal === 'hermes' ? [] : [terminal])],
        { timeout: 120_000 }
      );
    } else {
      await runBoundaryCompose(
        [
          ...buildComposeProfileArgs(),
          'up',
          '-d',
          '--no-deps',
          '--force-recreate',
          'hermes',
          'hermes-webui',
          // Writes and shell commands for project folders run here under ssh.
          'hermes-worker',
          // Project aliases changed (a project added, removed or moved): opencode-mcp reads
          // CODING_PATH_ALIASES at start. Otherwise leave it, so coding tasks keep running.
          ...(aliasesChanged ? ['opencode-mcp'] : []),
        ],
        { timeout: 180_000 }
      );
    }
    const ports = getStoredAssistantPorts();
    await waitUntilAssistantHealthy(ports, 120_000);
    if (!isLocalAssistantStackMode()) {
      recordHermesCodingRoots(currentCodingRoots());
      if (aliasesChanged) recordAppliedCodingAliases(aliases);
    }
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Recreate the coding agent so new coding mounts and CODING_EXTRA_ROOTS take effect
 * (ADR 0028 §4). Hermes and its WebUI keep running under the ssh backend, so chats don't
 * drop; Hermes's own edits in new folders start at its next restart.
 */
export async function recreateCodingAgentForMounts(
  onProgress?: (message: string) => void
): Promise<{ success: boolean; error?: string }> {
  try {
    onProgress?.('Restarting the coding agent…');
    await runBoundaryCompose(
      [
        ...buildComposeProfileArgs(),
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        'opencode',
        'opencode-mcp',
        // Runs Hermes's shell and file tools, and so holds the coding mounts.
        'hermes-worker',
      ],
      { timeout: 180_000 }
    );
    await waitUntilCodingAgentUp(getStoredAssistantPorts());
    // opencode-mcp just started with the current aliases too.
    recordAppliedCodingAliases(currentCodingPathAliases());
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/** OpenCode answers HTTP (any status, since it wants basic auth) once it is listening. */
export async function waitUntilCodingAgentUp(
  ports: AssistantStackPorts,
  timeoutMs = 120_000
): Promise<void> {
  const url = `http://127.0.0.1:${ports.opencode}/`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        await fetch(url, { signal: controller.signal });
        return;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      await new Promise((r) => setTimeout(r, ASSISTANT_STACK_HEALTH_INTERVAL_MS));
    }
  }
  throw new Error(`The coding agent did not come back at ${url} within ${timeoutMs}ms`);
}

/** True when the coding agent's container can open the folder (ADR 0028 §7). */
export async function isCodingRootVisible(hostPath: string): Promise<boolean> {
  try {
    // Through sh, so it works whether or not the image ships a standalone `test` binary.
    await runBoundaryCompose(['exec', '-T', 'opencode', 'sh', '-c', 'test -d "$1"', 'sh', hostPath], {
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Host bridge (ADR 0027): start it and put its tokens in each profile's `.env`. Returns the
 * bridge, or null when it can't start, and whether a `.env` changed, which Hermes reads at
 * start-up. Never throws: without a bridge Hermes keeps its old entry, whose calls fail until a
 * later launch provisions a working one. While the user has access stopped no bridge runs, but
 * the `.env` still gets the stored tokens, which Stop agent rotated, so turning access back on
 * needs no restart.
 */
async function provisionHostBridgeTokens(
  dataRoot: string,
  profiles: readonly string[]
): Promise<{ bridge: HostBridgeEndpoints | null; envChanged: boolean }> {
  try {
    const bridge = isHostBridgeAgentStopped() ? null : await ensureHostBridgeStarted();
    const tokens = bridge
      ? { mcp: bridge.mcpToken, browser: bridge.browserToken }
      : { mcp: await ensureHostBridgeToken('mcp'), browser: await ensureHostBridgeToken('browser') };
    const env = await writeHostBridgeTokensToProfiles(dataRoot, profiles, tokens);
    return { bridge, envChanged: env.changed };
  } catch (error) {
    persistDebugLog('assistant-stack', 'host bridge not provisioned into Hermes', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { bridge: null, envChanged: false };
  }
}

/**
 * Once Hermes serves again, ask it to reconnect to the bridge now rather than on its parked
 * timer (ADR 0027). Best effort: an older stack answers 404 and Hermes's own retry still works.
 */
async function wakeHermesForHostBridge(): Promise<void> {
  const result = await wakeHermesBridgeServer({
    apiBaseUrl: resolveHermesStackEndpoints().apiBaseUrl,
    apiKey: resolveApiServerKey(),
  });
  persistDebugLog('assistant-stack', 'host bridge wake', { ...result });
  if (result.outcome === 'woken') hostBridgeWakeAccepted();
}

/**
 * Boundary's browser URL for `browser.cdp_url` when the user has it on, else '' (clear
 * Boundary's URL; a developer's own `cdp_url` is left alone).
 */
function hermesBrowserCdpUrl(bridge: HostBridgeEndpoints): string {
  return getHostBridgeBrowserSettings().enabled
    ? hostBridgeCdpUrl(bridge.browserPort, bridge.browserToken)
    : '';
}

/** The stack's own profiles and the agents' (orchestrator included), which its bootstrap never saw. */
function allHermesProfiles(): string[] {
  return [...new Set<string>([...HERMES_CONFIG_PROFILES, ...agentProfileNames()])];
}

/**
 * What each profile should hold.
 *
 * - `modelId`: the model settings, as the stack's bootstrap (configure_model_proxy) and
 *   scripts/model-use.sh write them, into every profile. Absent in local-stack mode, where the
 *   developer's stack keeps its own.
 * - `limits`: into every profile that gets the model settings, and always into the agents',
 *   which the bootstrap never sizes. Null when there's no model to size them from.
 * - The platform hint: the default profile, where room turns and the built-in agent run, and
 *   every agent. Local-stack mode writes it too: Hermes reads it only for Boundary's sessions.
 * - The default profile's chosen MCP servers: every agent.
 * - The host bridge entry and Boundary's browser: every profile.
 */
function desiredHermesConfig(input: {
  profiles: readonly string[];
  agents: readonly string[];
  modelId?: string;
  limits: HermesProfileLimits | null;
  defaultConfig: Record<string, unknown> | null | undefined;
  bridge: HostBridgeEndpoints | null;
  /**
   * llm-proxy talks to the inference router, so Hermes sends it the session header (ADR 0033
   * §7). When false, profiles in `routerEntryProfiles` get the header turned off; others are
   * left alone so a stack that never routed isn't rewritten.
   */
  routed?: boolean;
  routerEntryProfiles?: ReadonlySet<string>;
}): DesiredHermesProfile[] {
  const mcpEntries = defaultMcpServerEntries(input.defaultConfig);
  const browserCdpUrl = input.bridge ? hermesBrowserCdpUrl(input.bridge) : undefined;
  return input.profiles.map((profile) => {
    const agent = input.agents.includes(profile);
    const set: Array<[string, string]> = [];
    let setIfUnset: Array<[string, string]> = [];
    if (input.modelId) {
      set.push(
        ['model.provider', 'custom'],
        ['model.base_url', LLM_PROXY_CLIENT_BASE_URL],
        ['model.default', input.modelId],
        ['model.model', input.modelId],
        // Overwrites the real key that earlier Boundary versions stored in each profile.
        ['model.api_key', LLM_PROXY_PLACEHOLDER_KEY],
        // Hermes's defaults. Earlier Boundary versions forced both on, which makes weaker or
        // quantized models fake tool calls in text more often (stack docs/hermes.md).
        ['agent.tool_use_enforcement', 'auto'],
        ['agent.execution_guidance', 'auto']
      );
    }
    if (input.limits && (input.modelId || agent)) {
      // The bootstrap sizes the stale timeout from LLM_BINDING_HOST only when the stack comes up.
      const limits = hermesProfileLimitSets(input.limits);
      set.push(...limits.set);
      setIfUnset = limits.setIfUnset;
    }
    if (agent || profile === '') {
      set.push([BOUNDARY_PLATFORM_HINT_KEY, BOUNDARY_PLATFORM_HINT]);
    }
    if (input.bridge) set.push(...hostBridgeHermesConfigSets(input.bridge.mcpPort));
    const entries = agent ? [...mcpEntries] : [];
    if (input.modelId && (input.routed || input.routerEntryProfiles?.has(profile))) {
      entries.push([
        HERMES_ROUTER_PROVIDER_KEY,
        {
          base_url: LLM_PROXY_CLIENT_BASE_URL,
          api_key: LLM_PROXY_PLACEHOLDER_KEY,
          session_affinity_header: input.routed ? HERMES_ROUTER_SESSION_HEADER : '',
        },
      ]);
    }
    return {
      profile,
      set,
      setIfUnset,
      entries,
      ...(browserCdpUrl !== undefined ? { browserCdpUrl } : {}),
    };
  });
}

/**
 * Bring each profile to `desired`, writing only what differs, every profile in one container
 * run. Profiles whose folder doesn't exist yet are skipped (Hermes creates them). A failure in
 * a `required` profile throws; others are logged. Returns whether Hermes must restart to read
 * what changed.
 */
async function writeHermesConfig(
  dataRoot: string,
  desired: readonly DesiredHermesProfile[],
  options: { required: readonly string[] }
): Promise<{ restart: boolean; profiles: string[] }> {
  const writes: HermesProfileWrites[] = [];
  const missing: string[] = [];
  for (const want of desired) {
    const current = readHermesProfileConfig(dataRoot, want.profile);
    if (current === undefined) {
      missing.push(want.profile);
      continue;
    }
    const planned = planHermesProfileWrites(want, current);
    if (hasHermesWrites(planned)) writes.push(planned);
  }
  const profiles = writes.map((w) => w.profile);
  persistDebugLog('assistant-stack', 'Hermes settings planned', {
    // Keys only: values can carry tokens.
    writes: writes.map((w) => ({ profile: w.profile, keys: [...w.set, ...w.entries].map(([key]) => key) })),
    ...(missing.length ? { missing } : {}),
  });
  if (writes.length === 0) return { restart: false, profiles };

  emitProgress(
    `Writing Hermes settings for ${writes.length} profile${writes.length === 1 ? '' : 's'}…`
  );
  const { composeWithInput } = getAssistantStackAccess();
  const out = await composeWithInput(HERMES_CONFIG_APPLY_ARGS, buildHermesConfigApplyInput(writes), {
    timeout: 120_000,
  });
  const results = parseHermesConfigApplyOutput(out.stdout);
  if (!results) {
    // stderr can quote the program's first line, which holds the values, so only its last
    // line's exception name is passed on.
    const lastLine = out.stderr.trim().split('\n').at(-1) ?? '';
    const name = /^([A-Za-z_.]*(?:Error|Exception))\b/.exec(lastLine)?.[1];
    throw new Error(`Hermes settings weren't written (exit ${out.code}${name ? `, ${name}` : ''}).`);
  }
  for (const result of results) {
    if (!result.error) continue;
    const label = result.profile === '' ? 'default' : result.profile;
    const detail = `${result.error}${result.key ? ` at ${result.key}` : ''}`;
    if (options.required.includes(result.profile)) {
      throw new Error(`Hermes profile “${label}” settings weren't written (${detail}).`);
    }
    persistDebugLog('assistant-stack', 'Hermes profile settings not written', { profile: label, error: detail });
  }
  return { restart: hermesWritesNeedRestart(writes), profiles };
}

/** After the user changes Boundary's browser settings: apply them to a running Hermes. */
export async function applyHostBridgeBrowserToHermes(): Promise<{ success: boolean; error?: string }> {
  try {
    if (!(await isAssistantStackReady())) {
      return { success: true }; // The next start provisions it.
    }
    const { root } = tryResolveAssistantRoot();
    const bridge = await ensureHostBridgeStarted();
    const browserCdpUrl = hermesBrowserCdpUrl(bridge);
    // Hermes reads `cdp_url` on every browser call, so this needs no restart.
    await writeHermesConfig(
      resolveAssistantDataRoot(root ?? undefined),
      allHermesProfiles().map((profile): DesiredHermesProfile => ({ profile, set: [], browserCdpUrl })),
      { required: HERMES_CONFIG_PROFILES }
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type LlmConnectionRequest =
  | {
      endpointUrl: string;
      apiKey: string;
      modelId: string;
      slot?: InferenceChainSlot;
      /** The chain to serve; absent means this connection alone (ADR 0033). */
      plan?: ChainPlan;
    }
  | undefined;

/**
 * Settings were written that Hermes reads at start-up, but its restart didn't finish. The diff
 * finds nothing left to write, so this makes the next apply restart anyway.
 */
let hermesRestartPending = false;
let hermesRestarting = false;

/**
 * A cancelled apply wrote settings and stopped before its restart, so the running Hermes never
 * read them. Putting the same settings back then needs no restart; anything else does.
 */
let hermesSettingsUnread = false;

interface ApplyRun {
  showProgress: boolean;
  onRestart: Array<() => void>;
  onStage: Array<(stage: HermesApplyStage) => void>;
  /** Stops the run at its next safe point. A restart already under way runs to its end. */
  signal?: AbortSignal;
  /** Restores what the running Hermes started with, after a cancelled apply. */
  restoresRunningHermes: boolean;
}

/** The apply running now, and the one request made during it, which runs once after it. */
let applyRunning: Promise<ApplyAssistantLlmResult> | null = null;
let applyRunningListeners: Array<() => void> = [];
let applyNext: (ApplyRun & {
  connection: LlmConnectionRequest;
  result: Promise<ApplyAssistantLlmResult>;
  start: (result: Promise<ApplyAssistantLlmResult>) => void;
}) | null = null;

/**
 * Push Boundary's verified LLM connection into all Hermes profiles inside the Boundary stack.
 * One apply runs at a time. A request made during one runs once after it, with the latest
 * connection asked for; every caller waiting on it gets that run's result.
 *
 * `showProgress` (start-up only) reports stages on the lifecycle, which keeps the start-up
 * screen up, and ends in `ready` or `error`. Without it the apply leaves the lifecycle alone,
 * so a re-apply on a running stack (new bridge tokens, a provider switch) doesn't replace the
 * app with the start-up screen; the caller shows any error.
 *
 * `onRestart` fires when the run this call waits on decides Hermes must restart. Most applies don't.
 * `onStage` reports the run's stages for a caller showing progress. `signal` cancels the run: the
 * latest request owns the queued run, so a later request without one makes it uncancellable.
 */
export function applyLlmConnectionToHermes(
  connection?: LlmConnectionRequest,
  {
    showProgress = false,
    onRestart,
    onStage,
    signal,
    restoresRunningHermes = false,
  }: {
    showProgress?: boolean;
    onRestart?: () => void;
    onStage?: (stage: HermesApplyStage) => void;
    signal?: AbortSignal;
    restoresRunningHermes?: boolean;
  } = {}
): Promise<ApplyAssistantLlmResult> {
  const listeners = onRestart ? [onRestart] : [];
  const stages = onStage ? [onStage] : [];
  if (!applyRunning) {
    return startApply(connection, { showProgress, onRestart: listeners, onStage: stages, signal, restoresRunningHermes });
  }
  if (applyNext) {
    applyNext.connection = connection;
    applyNext.showProgress ||= showProgress;
    applyNext.onRestart.push(...listeners);
    applyNext.onStage.push(...stages);
    applyNext.signal = signal;
    applyNext.restoresRunningHermes = restoresRunningHermes;
    return applyNext.result;
  }
  let start!: (result: Promise<ApplyAssistantLlmResult>) => void;
  const result = new Promise<ApplyAssistantLlmResult>((resolve) => {
    start = resolve;
  });
  applyNext = {
    connection,
    showProgress,
    onRestart: listeners,
    onStage: stages,
    signal,
    restoresRunningHermes,
    result,
    start,
  };
  return result;
}

function startApply(connection: LlmConnectionRequest, options: ApplyRun): Promise<ApplyAssistantLlmResult> {
  const run = applyLlmConnectionOnce(connection, options).catch((error: unknown) => ({
    success: false as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  applyRunning = run;
  applyRunningListeners = options.onRestart;
  void run.then(() => {
    const next = applyNext;
    applyNext = null;
    if (next) next.start(startApply(next.connection, next));
    else applyRunning = null;
  });
  return run;
}

/**
 * Wait out any apply, so a turn doesn't start while Hermes restarts or on a model being replaced.
 * `onRestart` fires if the run going now restarts Hermes, at once if it already is.
 */
export async function settleHermesApply(onRestart?: () => void): Promise<void> {
  if (!applyRunning) return;
  if (onRestart) {
    if (hermesRestarting) onRestart();
    else applyRunningListeners.push(onRestart);
  }
  while (applyRunning) await applyRunning;
}

async function applyLlmConnectionOnce(
  connection: LlmConnectionRequest,
  { showProgress, onRestart, onStage, signal, restoresRunningHermes }: ApplyRun
): Promise<ApplyAssistantLlmResult> {
  const reportStage = (applyStage: HermesApplyStage) => {
    for (const listener of onStage) listener(applyStage);
  };
  // Metadata only: how long each step took, for the debug log.
  const stepsMs: Record<string, number> = {};
  let stepStartedAt = Date.now();
  const stepDone = (name: string) => {
    const now = Date.now();
    stepsMs[name] = now - stepStartedAt;
    stepStartedAt = now;
  };
  const stage = (message: string) => {
    if (showProgress) emitStage('configureLlm', message);
  };
  const progress = (message: string) => {
    if (showProgress) emitProgress(message);
  };
  const report = (snapshot: AssistantStackLifecycleSnapshot) => {
    if (showProgress) setLifecycle(snapshot);
  };
  const reportReady = (local: boolean) =>
    report(
      createLifecycleSnapshot('ready', {
        message: local ? 'Local stack ready (LLM env files updated when present).' : 'Assistant stack is ready.',
        stage: 'ready',
        services: markStackReadyAfterEnsure(
          lifecycleSnapshot.services.length ? lifecycleSnapshot.services : seedServiceProgress()
        ),
      })
    );
  let apiKey: string | undefined;
  try {
    if (signal?.aborted) return { success: false, cancelled: true };
    // A shared model has no connection of its own; the store keeps it apart from the slots.
    const appShared = connection ? null : getAppSharedModel();
    const llm = connection ?? (appShared ? sharedModelConnection(appShared.modelId ?? '') : await getLlmConnection());
    apiKey = llm?.apiKey;
    if (!llm?.endpointUrl || !llm.apiKey || !llm.modelId) {
      return { success: false, error: 'No configured LLM connection to apply.' };
    }
    const slot =
      connection?.slot ??
      (appShared ? 'peer' : getAppDefaultSlot()) ??
      classifyInferenceSlot({ endpointUrl: llm.endpointUrl });

    if (!(await isAssistantStackReady())) {
      return { success: false, error: 'Assistant stack is not ready.' };
    }

    const local = isLocalAssistantStackMode();
    // A chat send passes its plan; start-up and Settings serve the app default's chain.
    const plan = connection ? (connection.plan ?? { kind: 'direct' as const }) : await planAppInferenceChain();
    if (slot === 'peer' && (local || plan.kind !== 'routed')) {
      // Nothing can serve yet. The stack is still up, and a send plans again and says why.
      persistDebugLog('assistant-stack', 'Shared model not applied', { local, plan: plan.kind });
      reportReady(local);
      return { success: true };
    }
    const routed = !local && plan.kind === 'routed' ? plan : null;
    // An offer that doesn't say leaves nothing to ask: a shared model has no address of its own.
    const contextLength =
      routed?.chain.contextLength ?? (slot === 'peer' ? undefined : await lookupModelContextLength(llm));
    stepDone('prepare');
    // The last point where nothing has changed yet. Everything after it changes the stack.
    if (signal?.aborted) return { success: false, cancelled: true };
    reportStage('applying');
    const { root } = tryResolveAssistantRoot();
    if (root) {
      stage(`Updating project .env and OpenCode for ${APP_NAME} LLM…`);
      await applyLlmConnectionToProjectFiles(
        root,
        { endpointUrl: llm.endpointUrl, apiKey: llm.apiKey, modelId: llm.modelId },
        { localStack: local }
      );
    }

    const upstreamUrl = rewriteLlmUrlForContainer(llm.endpointUrl);
    setInferenceRouterChain(routed?.chain ?? null);

    if (!local) {
      // The real endpoint and key go to llm-proxy, in memory only, on every apply (ADR 0026).
      // Everything inside the stack talks to the proxy with a placeholder key. A chain sends
      // the proxy to the router instead, which holds the real keys (ADR 0033 §5).
      stage('Updating the model proxy…');
      const router = routed ? await ensureInferenceRouter() : null;
      const upstream: LlmProxyUpstream = router
        ? { url: inferenceRouterProxyUrl(router.port), apiKey: router.token }
        : { url: upstreamUrl, apiKey: llm.apiKey };
      keepLlmProxyUpstream(() => llmProxyTarget(root), upstream);
      let proxied = await pushLlmConnectionToProxy(root, upstream);
      if (proxied.status) noteLlmProxyPushed(proxied.status);
      // The keeper pushes the same upstream again if this one fails, so the router counts as pushed.
      if (router) noteInferenceRouterPushed(router.port);
      if (!proxied.ok) {
        persistDebugLog('assistant-stack', 'llm-proxy push failed; recreating it', {
          error: proxied.error,
        });
        await runBoundaryCompose(
          [...buildComposeProfileArgs(), 'up', '-d', '--no-deps', 'llm-proxy'],
          { timeout: 120_000 }
        );
        proxied = await pushLlmConnectionToProxy(root, upstream, LLM_PROXY_PUSH_RETRY.attempts);
        if (proxied.status) noteLlmProxyPushed(proxied.status);
        if (!proxied.ok) {
          // The keeper keeps trying while Boundary runs.
          persistDebugLog('assistant-stack', 'llm-proxy push failed after recreate', {
            error: proxied.error,
          });
        }
      }
    }

    stepDone('proxy');
    stage('Configuring Hermes inference endpoint…');
    const dataRoot = resolveAssistantDataRoot(root ?? undefined);
    const profiles = allHermesProfiles();
    const { bridge, envChanged } = await provisionHostBridgeTokens(dataRoot, profiles);
    // The developer's own stack keeps its model settings (local-stack mode); its agents'
    // profiles are Boundary's, so they still get the limits and MCP servers.
    const written = await writeHermesConfig(
      dataRoot,
      desiredHermesConfig({
        profiles,
        agents: agentProfileNames(),
        modelId: local ? undefined : llm.modelId,
        limits: profileLimitsFor(
          root,
          routed ? rewriteLlmUrlForContainer(routed.slowestUrl) : upstreamUrl,
          contextLength
        ),
        defaultConfig: readHermesProfileConfig(dataRoot, ''),
        bridge,
        routed: Boolean(routed),
        routerEntryProfiles: new Set(
          profiles.filter((profile) => hasHermesRouterEntry(readHermesProfileConfig(dataRoot, profile)))
        ),
      }),
      { required: local ? [] : HERMES_CONFIG_PROFILES }
    );

    stepDone('settings');
    // The last point before the restart, which can't be stopped once it starts.
    if (signal?.aborted) {
      hermesSettingsUnread ||= written.restart;
      hermesRestartPending ||= envChanged;
      return { success: false, cancelled: true };
    }
    const settingsNeedRestart =
      restoresRunningHermes && hermesSettingsUnread ? false : written.restart || hermesSettingsUnread;
    hermesSettingsUnread = false;
    const restart = settingsNeedRestart || envChanged || hermesRestartPending;
    if (restart) {
      hermesRestartPending = true;
      hermesRestarting = true;
      for (const listener of onRestart) listener();
      reportStage('restarting');
      progress(`Restarting Hermes to apply ${APP_NAME}’s settings…`);
      try {
        if (local) await runLiveLocalStackCompose(['restart', 'hermes'], { timeout: 120_000 });
        else await restartHermesService();
        stepDone('restart');
        reportStage('starting');
        // A stack with many profiles and plugins can take over two minutes to serve again after
        // a restart, so this uses the full stack-start budget.
        await waitUntilAssistantHealthy(getStoredAssistantPorts());
        stepDone('health');
        hermesRestartPending = false;
      } catch (error) {
        if (!local) throw error;
        const message = `Hermes didn't come back after restarting for ${APP_NAME}'s settings: ${
          error instanceof Error ? error.message : String(error)
        }`;
        report(
          createLifecycleSnapshot('error', {
            message,
            error: message,
            stage: 'error',
            services: lifecycleSnapshot.services,
          })
        );
        return { success: false, error: message };
      } finally {
        hermesRestarting = false;
      }
    }
    persistDebugLog('assistant-stack', 'Hermes settings applied', {
      profiles: written.profiles,
      envChanged,
      restarted: restart,
      stepsMs,
    });
    if (local) {
      progress('Local stack mode: kept Hermes model settings (live stack keeps its runtime config).');
    }
    void wakeHermesForHostBridge();

    reportReady(local);

    rememberLastApplied(slot, llm.endpointUrl, llm.modelId, contextLength, Boolean(routed));
    return { success: true };
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), [
      apiKey,
    ]);
    // Without this the UI stays on the last progress line (often the health wait) forever.
    report(
      createLifecycleSnapshot('error', {
        message,
        error: message,
        stage: 'error',
        services: lifecycleSnapshot.services,
      })
    );
    return { success: false, error: message };
  }
}

/** Retries for a push right after recreating the proxy, while it starts. */
export const LLM_PROXY_PUSH_RETRY = { attempts: 10, delayMs: 1_000 };

function llmProxyTarget(root: string | null): LlmProxyTarget | null {
  const token = root ? readLlmProxyAdminToken(root) : null;
  return token ? { adminPort: getStoredAssistantPorts().llmProxyAdmin, token } : null;
}

/** Send the upstream to llm-proxy's admin API (chat and LightRAG routes). */
async function pushLlmConnectionToProxy(
  root: string | null,
  upstream: LlmProxyUpstream,
  attempts = 1
): Promise<{ ok: boolean; error?: string; status?: LlmProxyStatus }> {
  const target = llmProxyTarget(root);
  if (!target) return { ok: false, error: 'LLM_PROXY_ADMIN_TOKEN is not set in the stack .env' };
  let error: string | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, LLM_PROXY_PUSH_RETRY.delayMs));
    }
    const result = await pushLlmProxyUpstream(target, upstream);
    if (result.ok) return { ok: true, status: 'status' in result ? result.status : undefined };
    error = 'error' in result ? result.error : undefined;
  }
  return { ok: false, error };
}

function rememberLastApplied(
  slot: InferenceChainSlot,
  endpointUrl: string,
  modelId: string,
  contextLength: number | undefined,
  routed: boolean
): void {
  setLastAppliedLlm({
    slot,
    endpointUrl,
    modelId,
    ...(contextLength ? { contextLength } : {}),
    ...(routed ? { routed } : {}),
    appliedAt: new Date().toISOString(),
  });
}

/** A profile already holds Boundary's router provider entry, from an earlier routed apply. */
function hasHermesRouterEntry(config: Record<string, unknown> | null | undefined): boolean {
  const providers = config?.providers;
  return Boolean(
    providers && typeof providers === 'object' && HERMES_ROUTER_PROVIDER_KEY.split('.')[1] in providers
  );
}

/** Profiles of the agents Boundary created (ADR 0010); the built-in one is the default profile. */
function agentProfileNames(): string[] {
  return listStoredAgents()
    .filter((agent) => !agent.builtIn)
    .map((agent) => agent.slug);
}

function profileLimitsFor(
  root: string | null | undefined,
  upstreamUrl: string,
  contextLength: number | undefined
): HermesProfileLimits {
  const env = root ? readAssistantEnvFile(root) : {};
  return {
    staleTimeoutS: hermesStaleTimeoutFor(upstreamUrl, env.HERMES_PROXY_STALE_TIMEOUT),
    maxTokens: hermesMaxTokensFor(env.HERMES_MAX_TOKENS),
    contextLength,
  };
}

/**
 * Set up a profile Boundary just created: the agent's share of {@link desiredHermesConfig}, in
 * one container run, without a restart. The limits need a model to size them from; without one
 * applied yet the first model change writes them.
 */
export async function setUpNewHermesProfile(profile: string): Promise<void> {
  if (!(await isAssistantStackReady())) return;
  const last = getLastAppliedLlm();
  const { root } = tryResolveAssistantRoot();
  const dataRoot = resolveAssistantDataRoot(root ?? undefined);
  const { bridge } = await provisionHostBridgeTokens(dataRoot, [profile]);
  await writeHermesConfig(
    dataRoot,
    desiredHermesConfig({
      profiles: [profile],
      agents: [profile],
      limits: last
        ? profileLimitsFor(root, rewriteLlmUrlForContainer(last.endpointUrl), last.contextLength)
        : null,
      defaultConfig: readHermesProfileConfig(dataRoot, ''),
      bridge,
    }),
    { required: [profile] }
  );
}

export interface AssistantStackAccess {
  /** Compose against the stack Boundary talks to (its own, or the developer's in local-stack mode). */
  compose: HermesConfigCompose;
  /** The same, with `input` on stdin. Resolves with the exit code instead of throwing. */
  composeWithInput: (
    args: string[],
    input: string,
    options?: { timeout?: number }
  ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
  /** Host folder holding `hermes/` (each profile's `config.yaml` and `.env`). */
  dataRoot: string;
}

/** For services that write into Hermes's profiles and run commands in the stack's containers. */
export function getAssistantStackAccess(): AssistantStackAccess {
  const { root, error } = tryResolveAssistantRoot();
  if (!root) throw new Error(error ?? 'Assistant root not found');
  const local = stackMode().kind === 'local';
  return {
    compose: activeStackCompose(),
    composeWithInput: async (args, input, options = {}) => {
      if (local) {
        const runtime = await getContainerRuntime();
        return runComposeStreaming(runtime, [...liveLocalStackFileArgs(root), ...args], {
          cwd: root,
          timeout: options.timeout,
          input,
        });
      }
      const ctx = await buildBoundaryComposeContext();
      return runComposeStreaming(ctx.runtime, [...ctx.projectArgs, ...args], {
        cwd: ctx.root,
        timeout: options.timeout,
        env: ctx.env,
        input,
      });
    },
    dataRoot: resolveAssistantDataRoot(root),
  };
}

/**
 * Full setup-step path: ensure running, then sync LLM into Hermes.
 */
export async function ensureAssistantStackAndApplyLlm(): Promise<EnsureAssistantStackResult> {
  const ensured = await ensureAssistantStackRunning();
  if (!ensured.success) {
    return ensured;
  }

  const applied = await applyLlmConnectionToHermes(undefined, { showProgress: true });
  if (!applied.success) {
    return {
      success: false,
      status: buildAssistantStackStatus({
        ready: ensured.status.ready,
        lastError: applied.error,
      }),
      error: applied.error,
    };
  }

  markAssistantStackSetupComplete();
  return {
    success: true,
    status: buildAssistantStackStatus({ ready: true }),
  };
}

/** On app launch after setup: bring stack back up and refresh LLM config. */
export async function ensureAssistantStackOnLaunch(): Promise<void> {
  if (!isAssistantStackSetupComplete()) {
    return;
  }
  if (!getAppSharedModel() && !(await getLlmConnection())) {
    // Every provider was disconnected. The app still opens, and Settings can connect one.
    await ensureAssistantStackRunning();
    return;
  }
  // Emit starting immediately so the product UI can gate before compose begins.
  setLifecycle(
    createLifecycleSnapshot('starting', {
      message: 'Starting assistant services…',
      services: seedServiceProgress('pending', 'Waiting…', 0),
    })
  );
  await ensureAssistantStackAndApplyLlm();
}

/** Exported for tests */
export const __test = {
  desiredHermesConfig,
  portsToComposeEnv,
  buildProjectArgs,
  arePortsAvailable,
  buildComposeProfileArgs,
  handleProgressLine,
  applyPsRow,
  getLifecycleSnapshot: () => lifecycleSnapshot,
  setLifecycleSnapshot: (snapshot: AssistantStackLifecycleSnapshot) => {
    lifecycleSnapshot = snapshot;
  },
  resetLifecycle: () => {
    lifecycleSnapshot = createLifecycleSnapshot('idle');
    ensureRunningPromise = null;
    hermesRestartPending = false;
  },
  getEnsureRunningPromise: () => ensureRunningPromise,
  resetReadyForTests: () => {
    lastReady = null;
    readyCallback = null;
  },
};
