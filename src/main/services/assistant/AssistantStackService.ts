import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import {
  ASSISTANT_STACK_DOWN_TIMEOUT_MS,
  ASSISTANT_STACK_HEALTH_INTERVAL_MS,
  ASSISTANT_STACK_HEALTH_TIMEOUT_MS,
  ASSISTANT_STACK_UP_TIMEOUT_MS,
  BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE,
  BOUNDARY_ASSISTANT_COMPOSE_PROFILE,
  BOUNDARY_ASSISTANT_COMPOSE_PROFILES,
  BOUNDARY_ASSISTANT_CONTAINER_PREFIX,
  BOUNDARY_ASSISTANT_IMAGE_PREFIX,
  BOUNDARY_ASSISTANT_PORT_OFFSET,
  BOUNDARY_ASSISTANT_PROJECT_NAME,
  BOUNDARY_HERMES_TERMINAL_BACKEND,
  DEFAULT_ASSISTANT_STACK_PORTS,
  HERMES_CONFIG_PROFILES,
  LIVE_LOCAL_STACK_START_TIMEOUT_MS,
  buildComposeProfileArgs,
} from '../../../shared/assistantStackConstants';
import { buildAssistantUiServiceCards } from '../../../shared/assistantUiServices';
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
import type { InferenceSlotId } from '../../../shared/types/onboarding';
import type {
  ApplyAssistantLlmResult,
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
import { classifyInferenceSlot, getAppDefaultSlot, getLlmConnection, getSlotLlmConnection } from '../onboarding/OpenAiOnboardingStore';
import {
  applyLlmConnectionToProjectFiles,
  clearLlmKeysFromProjectEnv,
  upsertEnvLine,
} from './applyLlmToProjectEnv';
import { buildHermesConfigSetExec, redactSecrets } from './hermesConfigSetExec';
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
  clearAssistantStackSetupComplete,
  getAssistantRootOverride,
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
  localStackResetBlockedMessage,
  localStackStopSkippedMessage,
} from './localStackMode';
import { LIVE_STACK_PS_ARGS, liveForeignProjectsAt } from './liveLocalStack';
import {
  ensureSovereignProjectProvisioned,
  isHostSetupComplete,
  markHostSetupComplete,
  markImagesBuilt,
  needsImageBuild,
  resetBoundaryAssistantStack,
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
  applyHermesProfileLimits,
  hermesMaxTokensFor,
  lookupModelContextLength,
  type HermesConfigCompose,
  type HermesProfileLimits,
} from './hermesProfileLimits';
import { listStoredAgents } from './hermes/hermesAgentStore';
import { copyDefaultMcpServers } from './hermesAgentMcpServers';
import { hasCalendarAccounts } from './calendar/calendarStore';
import { CALENDAR_COMPOSE_PROFILE } from './calendar/calendarModel';
import { rewriteLlmUrlForContainer } from './rewriteLlmUrlForContainer';
import { runSovereignSetup } from './runSovereignSetup';
import { syncStackImagePins } from './stackImagePins';
import { persistDebugLog } from '../../persistDebugLog';
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
import { getHostBridgeBrowserSettings } from '../hostBridge/hostBridgeStore';
import { wakeHermesBridgeServer } from '../hostBridge/hermesWake';
import { resolveApiServerKey, resolveHermesStackEndpoints } from './hermes/hermesEndpoints';
import {
  hostBridgeCdpUrl,
  hostBridgeHermesConfigSets,
  profilesNeedingBridgeConfig,
  profilesNeedingBrowserConfig,
  writeHostBridgeTokensToProfiles,
} from '../hostBridge/hermesProvision';
import {
  ensureProjectMountPoints,
  hermesProjectsOverlayExists,
  writeHermesProjectsOverlay,
  resolveHermesProjectsOverlayPath,
} from './hermes/hermesProjectsOverlay';

export type AssistantStackProgressCallback = (message: string) => void;
export type AssistantStackLifecycleCallback = (
  snapshot: AssistantStackLifecycleSnapshot
) => void;

let progressCallback: AssistantStackProgressCallback | null = null;
let lifecycleCallback: AssistantStackLifecycleCallback | null = null;
let lifecycleSnapshot: AssistantStackLifecycleSnapshot = createLifecycleSnapshot('idle');
/** Single-flight for ensure so background + setup step share one bring-up. */
let ensureRunningPromise: Promise<EnsureAssistantStackResult> | null = null;

export function setAssistantStackProgressCallback(
  callback: AssistantStackProgressCallback | null
): void {
  progressCallback = callback;
}

export function setAssistantStackLifecycleCallback(
  callback: AssistantStackLifecycleCallback | null
): void {
  lifecycleCallback = callback;
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
  progressCallback?.('Quit requested — stopping assistant containers…');
}

function emitProgress(message: string): void {
  progressCallback?.(message);
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
  progressCallback?.(message);
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

function setLifecycle(snapshot: AssistantStackLifecycleSnapshot): void {
  const prev = lifecycleSnapshot;
  const reset = isLifecycleWaveBoundary(prev.phase, snapshot.phase);
  const services =
    reset || prev.services.length === 0
      ? snapshot.services
      : mergeServicesById(prev.services, snapshot.services, `setLifecycle:${prev.phase}→${snapshot.phase}`);
  const stageChanged =
    snapshot.stage !== undefined && snapshot.stage !== prev.stage;
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

function handleProgressLine(line: string): void {
  const event = parseComposeProgressLine(line);
  if (!event) return;
  const nextServices = applyComposeProgressEvent(lifecycleSnapshot.services, event);
  if (nextServices !== lifecycleSnapshot.services) {
    setLifecycle({ ...lifecycleSnapshot, services: nextServices });
  }
}

function offsetPorts(base: AssistantStackPorts, offset: number): AssistantStackPorts {
  return {
    gateway: base.gateway + offset,
    apiServer: base.apiServer + offset,
    dashboard: base.dashboard + offset,
    webui: base.webui + offset,
    searxng: base.searxng + offset,
    lightrag: base.lightrag + offset,
    neo4jHttp: base.neo4jHttp + offset,
    neo4jBolt: base.neo4jBolt + offset,
    opencode: base.opencode + offset,
    gptResearcher: base.gptResearcher + offset,
    n8n: base.n8n + offset,
    llmProxyAdmin: base.llmProxyAdmin + offset,
  };
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
  if (await arePortsAvailable(defaults)) {
    return { ports: defaults, isolationMode: 'default-ports' };
  }

  const offset = offsetPorts(defaults, BOUNDARY_ASSISTANT_PORT_OFFSET);
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
  let overlayPath: string | null = null;
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
  return httpGetOk(`http://127.0.0.1:${ports.apiServer}/health`);
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
      // No hermes-worker yet: shell and file tools run in the hermes container, and
      // upstream's terminal-local.yml puts the workspace mounts there.
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
 * Stream Compose with `--progress=json`, optionally polling `ps` as a fallback.
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
  let lineCount = 0;
  const onLine = (line: string) => {
    if (line.trim()) lineCount += 1;
    const before = lifecycleSnapshot.services;
    handleProgressLine(line);
    if (lifecycleSnapshot.services !== before) {
      sawJsonProgress = true;
    }
  };

  let pollTimer: ReturnType<typeof setInterval> | undefined;
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

    if (result.code !== 0 && result.code != null) {
      const detail = (result.stderr || result.stdout || '').trim().slice(-2_000);
      // Older compose builds may reject `--progress=json`; retry without it,
      // but keep compose ps polling so cards still advance.
      if (/progress|unknown flag|unknown option/i.test(detail)) {
        let fallbackPoll: ReturnType<typeof setInterval> | undefined;
        if (options.pollPs !== false) {
          fallbackPoll = setInterval(() => {
            void reconcileFromComposePs(ctx).catch(() => {
              /* best-effort */
            });
          }, 1_500);
        }
        try {
          const fallback = await runCompose(ctx.runtime, [...ctx.projectArgs, ...args], {
            cwd: ctx.root,
            timeout: options.timeout,
            env: ctx.env,
          });
          await reconcileFromComposePs(ctx).catch(() => {
            /* best-effort */
          });
          return fallback;
        } finally {
          if (fallbackPoll) clearInterval(fallbackPoll);
        }
      }
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
  } finally {
    if (pollTimer) clearInterval(pollTimer);
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
  } catch (err) {
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
  } catch (err) {
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

  const stateRaw = String(row.State ?? row.Status ?? row.state ?? row.status ?? '').toLowerCase();
  let text = 'Updating…';
  let progress = 0.55;
  let state: AssistantStackServiceProgress['state'] = 'working';

  if (stateRaw.includes('healthy')) {
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
  const next = upsertEnvLine(contents, 'HERMES_TERMINAL_BACKEND', BOUNDARY_HERMES_TERMINAL_BACKEND);
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
    await repairApiServerListenPort(dataRoot);
  }

  if (hermesConfigExists(dataRoot)) {
    return;
  }

  if (localMode) {
    throw new Error(
      'Hermes config.yaml is missing under the local assistant data directory. ' +
        'Run setup from your sovereign-agent-stack checkout (or start the stack there) ' +
        'before using bun run dev:local-stack. Boundary will not run hermes setup --reset ' +
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
      'Hermes setup did not create config.yaml under Boundary assistant data. Re-run Setup or reset the assistant stack and try again.'
    );
  }
}

/**
 * Earlier dual-stack runs set API_SERVER_PORT to the host publish port (e.g. 18643).
 * Inside the container the process must listen on 8643 (mapped host→8643).
 */
async function repairApiServerListenPort(dataRoot: string): Promise<boolean> {
  const envPath = path.join(dataRoot, 'hermes', 'profiles', 'api-server', '.env');
  if (!fs.existsSync(envPath)) {
    return false;
  }
  const original = await fs.promises.readFile(envPath, 'utf8');
  const expected = `API_SERVER_PORT=${DEFAULT_ASSISTANT_STACK_PORTS.apiServer}`;
  if (new RegExp(`^${expected}$`, 'm').test(original)) {
    return false;
  }
  let next: string;
  if (/^API_SERVER_PORT=/m.test(original)) {
    next = original.replace(/^API_SERVER_PORT=.*$/m, expected);
  } else {
    next = `${original.replace(/\s*$/, '')}\n${expected}\n`;
  }
  await fs.promises.writeFile(envPath, next, 'utf8');
  return true;
}

function hasExplicitAssistantRootOverride(): boolean {
  return Boolean(process.env.BOUNDARY_ASSISTANT_ROOT?.trim() || getAssistantRootOverride());
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
 * Requires BOUNDARY_LOCAL_STACK=1 (set by `bun run dev:local-stack`).
 *
 * If Hermes isn't answering yet but the checkout's own Compose project has running
 * containers (a `make up` still starting, or one whose Hermes is down), wait for it rather
 * than starting `boundary-assistant` beside it: both bind the same host ports. Throws when
 * that stack doesn't become healthy in time.
 */
async function tryAttachToLiveLocalStack(): Promise<boolean> {
  if (process.env.BOUNDARY_LOCAL_STACK?.trim() !== '1') {
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
          'Boundary will not start a second copy beside it, since both use the same ports. ' +
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

    if (!hasExplicitAssistantRootOverride()) {
      emitStage('provision', 'Provisioning Boundary-managed agent stack…');
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
      const llmForEnv = getLlmConnection();
      if (llmForEnv?.endpointUrl && llmForEnv.apiKey && llmForEnv.modelId) {
        emitProgress('Writing Boundary LLM settings into project .env…');
        await applyLlmConnectionToProjectFiles(root, llmForEnv);
      }
    }

    // Earlier Boundary versions wrote the real key into .env. The proxy now gets it through
    // its admin API, so a proxy created from an old .env must be recreated to drop it.
    const proxyHasStaleKey = boundaryOwned && (await clearLlmKeysFromProjectEnv(root));

    if (boundaryOwned) {
      // A file written by an older Boundary may restate mounts this stack no longer has.
      const projects = listStoredHermesProjects();
      writeHermesProjectsOverlay(projects);
      ensureProjectMountPoints(projects, path.join(resolveAssistantUserContentRoot(root), 'projects'));
      if (BOUNDARY_HERMES_TERMINAL_BACKEND === 'ssh' && (await ensureHermesWorkerKey(root))) {
        emitProgress('Created a new SSH key for the tool worker.');
      }
    }

    emitProgress('Preparing Boundary assistant data directory…');
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
    // --clone and then exit 1 on set_yaml_list. Clean again immediately before up.
    await removeIncompleteHermesProfiles(dataRoot);

    // After a pin change, rebuild the stack's local images once (stack CHANGELOG upgrade
    // steps). Unchanged images come from the build cache.
    const buildImages = boundaryOwned && needsImageBuild();
    if (buildImages) emitProgress('Building the agent stack’s local images for this version…');

    emitStage('compose', startMessage);
    await runBoundaryComposeWithProgress(
      [...buildComposeProfileArgs(), 'up', '-d', ...(buildImages ? ['--build'] : [])],
      {
        timeout: ASSISTANT_STACK_UP_TIMEOUT_MS,
        openCodeConfigFile,
        workspaceRoot,
      }
    );

    emitStage('health', 'Waiting for Hermes health check…');
    await waitUntilAssistantHealthy(ports);
    // `up` recreates hermes and opencode-mcp whenever their coding variables changed.
    recordHermesCodingRoots(currentCodingRoots());
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
  }
}

export async function stopAssistantStack(): Promise<StopAssistantStackResult> {
  try {
    if (isLocalAssistantStackMode()) {
      // Leave the lifecycle as it is: 'stopping'/'stopped' put up the quit overlay.
      progressCallback?.(localStackStopSkippedMessage());
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
    emitProgress('Stopping Boundary assistant stack…');
    stopKeepingLlmProxyUpstream();
    setLifecycle(
      createLifecycleSnapshot('stopping', {
        message: 'Stopping Boundary assistant stack…',
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
 * Recreate Hermes (and WebUI) so generated host-folder bind mounts take effect.
 * Surfaces a short connecting progress message via the lifecycle callback.
 */
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
      await runLiveLocalStackCompose(
        ['up', '-d', '--no-deps', 'hermes'],
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
          ...(BOUNDARY_HERMES_TERMINAL_BACKEND === 'ssh' ? ['hermes-worker'] : []),
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

/** The service that runs Hermes's shell and file tools, and so holds coding mounts. */
function codingTerminalService(): string {
  return BOUNDARY_HERMES_TERMINAL_BACKEND === 'ssh' ? 'hermes-worker' : 'hermes';
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
        codingTerminalService(),
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
 * Host bridge (ADR 0027): put the bridge tokens in each profile's `.env` and the
 * `mcp_servers.boundary` entry in each profile's config, writing only what is missing or
 * different. Returns whether anything changed, so the caller knows Hermes needs a restart.
 * Never throws: without a bridge Hermes keeps its old entry, whose calls fail until a later
 * launch provisions a working one.
 */
type HermesCompose = (args: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv }) => Promise<unknown>;

async function provisionHostBridgeIntoHermes(root: string | undefined, compose: HermesCompose): Promise<boolean> {
  try {
    const bridge = await ensureHostBridgeStarted();
    const dataRoot = resolveAssistantDataRoot(root);
    const env = await writeHostBridgeTokensToProfiles(dataRoot, HERMES_CONFIG_PROFILES, {
      mcp: bridge.mcpToken,
      browser: bridge.browserToken,
    });
    const stale = await profilesNeedingBridgeConfig(dataRoot, HERMES_CONFIG_PROFILES, bridge.mcpPort);
    for (const profile of stale) {
      for (const [key, value] of hostBridgeHermesConfigSets(bridge.mcpPort)) {
        // Not secret: the token is referenced by name, so no env forwarding is needed.
        const { args } = buildHermesConfigSetExec(profile, key, value);
        await compose(args, { timeout: 60_000 });
      }
    }
    const browserProfiles = await syncHermesBrowserSetting(dataRoot, bridge, compose);
    const changed = env.changed || stale.length > 0;
    persistDebugLog('assistant-stack', 'host bridge provisioned into Hermes', {
      mcpPort: bridge.mcpPort,
      envChanged: env.changed,
      configProfiles: stale,
      browserProfiles,
    });
    return changed;
  } catch (error) {
    persistDebugLog('assistant-stack', 'host bridge not provisioned into Hermes', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
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
 * Point each profile's `browser.cdp_url` at Boundary's browser when it is on, or clear Boundary's
 * URL when it is off (a developer's own `cdp_url` is left alone). Hermes reads `cdp_url` on every
 * browser call, so this never needs a restart. Returns the profiles changed.
 */
async function syncHermesBrowserSetting(
  dataRoot: string,
  bridge: HostBridgeEndpoints,
  compose: HermesCompose
): Promise<string[]> {
  const desired = getHostBridgeBrowserSettings().enabled
    ? hostBridgeCdpUrl(bridge.browserPort, bridge.browserToken)
    : '';
  const stale = await profilesNeedingBrowserConfig(dataRoot, HERMES_CONFIG_PROFILES, desired);
  for (const profile of stale) {
    // Secret: the URL carries the browser token, so it travels in the env, not on a command line.
    const { args, env } = buildHermesConfigSetExec(profile, 'browser.cdp_url', desired, { secret: true });
    await compose(args, { timeout: 60_000, env });
  }
  return stale;
}

/** After the user changes Boundary's browser settings: apply them to a running Hermes. */
export async function applyHostBridgeBrowserToHermes(): Promise<{ success: boolean; error?: string }> {
  try {
    if (!(await isAssistantStackReady())) {
      return { success: true }; // The next start provisions it.
    }
    const { root } = tryResolveAssistantRoot();
    const bridge = await ensureHostBridgeStarted();
    const compose: HermesCompose = isLocalAssistantStackMode() ? runLiveLocalStackCompose : runBoundaryCompose;
    await syncHermesBrowserSetting(resolveAssistantDataRoot(root ?? undefined), bridge, compose);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Push Boundary's verified LLM connection into all Hermes profiles inside the Boundary stack.
 */
export async function applyLlmConnectionToHermes(connection?: {
  endpointUrl: string;
  apiKey: string;
  modelId: string;
  slot?: InferenceSlotId;
}): Promise<ApplyAssistantLlmResult> {
  let apiKey: string | undefined;
  try {
    const llm = connection ?? getLlmConnection();
    apiKey = llm?.apiKey;
    if (!llm?.endpointUrl || !llm.apiKey || !llm.modelId) {
      return { success: false, error: 'No configured LLM connection to apply.' };
    }
    const slot =
      connection?.slot ??
      getAppDefaultSlot() ??
      classifyInferenceSlot({ endpointUrl: llm.endpointUrl });

    if (!(await isAssistantStackReady())) {
      return { success: false, error: 'Assistant stack is not ready.' };
    }

    const { root } = tryResolveAssistantRoot();
    if (root) {
      emitStage('configureLlm', 'Updating project .env and OpenCode for Boundary LLM…');
      await applyLlmConnectionToProjectFiles(
        root,
        { endpointUrl: llm.endpointUrl, apiKey: llm.apiKey, modelId: llm.modelId },
        { localStack: isLocalAssistantStackMode() }
      );
    }

    const contextLength = await lookupModelContextLength(llm);

    if (isLocalAssistantStackMode()) {
      // The developer's own stack keeps its model settings. Only the host bridge (ADR 0027) is
      // added, and Hermes restarts only when that entry or its tokens actually changed. The
      // agents' profiles are Boundary's, so they still get the limits and MCP servers its
      // bootstrap never wrote.
      await setUpAgentProfiles(
        runLiveLocalStackCompose,
        profileLimitsFor(root, rewriteLlmUrlForContainer(llm.endpointUrl), contextLength)
      );
      if (await provisionHostBridgeIntoHermes(root ?? undefined, runLiveLocalStackCompose)) {
        emitProgress('Restarting Hermes so it can reach Boundary on this computer…');
        try {
          await runLiveLocalStackCompose(['restart', 'hermes'], { timeout: 120_000 });
          // A dev stack with many profiles and plugins can take over two minutes to serve again,
          // so this uses the full stack-start budget rather than the post-config one.
          await waitUntilAssistantHealthy(getStoredAssistantPorts());
        } catch (error) {
          const message = `Hermes didn't come back after restarting for Boundary's host tools: ${
            error instanceof Error ? error.message : String(error)
          }`;
          setLifecycle(
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
      emitProgress(
        'Local stack mode: kept Hermes model settings (live stack keeps its runtime config).'
      );
      void wakeHermesForHostBridge();
      const baseServices = lifecycleSnapshot.services.length
        ? lifecycleSnapshot.services
        : seedServiceProgress();
      setLifecycle(
        createLifecycleSnapshot('ready', {
          message: 'Local stack ready (LLM env files updated when present).',
          stage: 'ready',
          services: markStackReadyAfterEnsure(baseServices),
        })
      );
      rememberLastApplied(slot, llm.endpointUrl, llm.modelId, contextLength);
      return { success: true };
    }

    // The real endpoint and key go to llm-proxy, in memory only. Everything inside the stack
    // talks to the proxy with a placeholder key.
    emitStage('configureLlm', 'Updating the model proxy…');
    const upstream: LlmProxyUpstream = {
      url: rewriteLlmUrlForContainer(llm.endpointUrl),
      apiKey: llm.apiKey,
    };
    keepLlmProxyUpstream(() => llmProxyTarget(root), upstream);
    let proxied = await pushLlmConnectionToProxy(root, upstream);
    if (proxied.status) noteLlmProxyPushed(proxied.status);
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

    emitStage('configureLlm', 'Configuring Hermes inference endpoint…');

    const limits = profileLimitsFor(root, upstream.url, contextLength);

    // Host bridge (ADR 0027). The restart below picks it up.
    await provisionHostBridgeIntoHermes(root ?? undefined, runBoundaryCompose);

    // The stack's own profiles and the agents' (orchestrator included), which the stack's
    // bootstrap never saw.
    const profiles = [...new Set<string>([...HERMES_CONFIG_PROFILES, ...agentProfileNames()])];
    let profileIndex = 0;
    for (const profile of profiles) {
      profileIndex += 1;
      const profileLabel = profile === '' ? 'default' : profile;
      emitProgress(
        `Configuring Hermes profile “${profileLabel}” (${profileIndex}/${profiles.length})…`
      );

      // Same as the stack's bootstrap (configure_model_proxy) and scripts/model-use.sh.
      // Overwrites the real key that earlier Boundary versions stored in each profile.
      const sets: Array<[string, string]> = [
        ['model.provider', 'custom'],
        ['model.base_url', LLM_PROXY_CLIENT_BASE_URL],
        ['model.default', llm.modelId],
        ['model.model', llm.modelId],
        ['model.api_key', LLM_PROXY_PLACEHOLDER_KEY],
        // Hermes's defaults. Earlier Boundary versions forced both on, which makes weaker or
        // quantized models fake tool calls in text more often (stack docs/hermes.md).
        ['agent.tool_use_enforcement', 'auto'],
        ['agent.execution_guidance', 'auto'],
      ];

      for (const [key, value] of sets) {
        const { args, env } = buildHermesConfigSetExec(profile, key, value);
        await runBoundaryCompose(args, { timeout: 60_000, env });
      }
      // The bootstrap sizes the stale timeout from LLM_BINDING_HOST only when the stack comes up.
      await applyHermesProfileLimits(runBoundaryCompose, profile, limits);

    }
    // The limits went in above; agents still need the default profile's MCP servers.
    await setUpAgentProfiles(runBoundaryCompose, null);

    emitProgress('Restarting Hermes to apply inference settings…');
    await restartHermesService();
    // A stack with many profiles and plugins can take over two minutes to serve again after a
    // restart, so this uses the full stack-start budget.
    await waitUntilAssistantHealthy(getStoredAssistantPorts());
    void wakeHermesForHostBridge();

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

    rememberLastApplied(slot, llm.endpointUrl, llm.modelId, contextLength);
    return { success: true };
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), [
      apiKey,
    ]);
    // Without this the UI stays on the last progress line (often the health wait) forever.
    setLifecycle(
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

export async function applyLlmSlotToHermes(slot: InferenceSlotId): Promise<ApplyAssistantLlmResult> {
  const llm = getSlotLlmConnection(slot);
  if (!llm) {
    return { success: false, error: 'That provider is not connected.' };
  }
  return applyLlmConnectionToHermes({ ...llm, slot });
}

function rememberLastApplied(
  slot: InferenceSlotId,
  endpointUrl: string,
  modelId: string,
  contextLength?: number
): void {
  setLastAppliedLlm({
    slot,
    endpointUrl,
    modelId,
    ...(contextLength ? { contextLength } : {}),
    appliedAt: new Date().toISOString(),
  });
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
 * Give one agent profile the setup the stack's bootstrap never wrote: the model limits (when
 * `limits` is given) and the default profile's MCP servers (hermesAgentMcpServers.ts).
 */
async function setUpAgentProfile(
  compose: HermesConfigCompose,
  profile: string,
  limits: HermesProfileLimits | null
): Promise<void> {
  if (limits) await applyHermesProfileLimits(compose, profile, limits);
  await copyDefaultMcpServers(compose, profile);
}

/** Best effort: a profile that can't be written is logged and the rest still are. */
async function setUpAgentProfiles(
  compose: HermesConfigCompose,
  limits: HermesProfileLimits | null
): Promise<void> {
  for (const profile of agentProfileNames()) {
    try {
      await setUpAgentProfile(compose, profile, limits);
    } catch (error) {
      // The message names the command, never a value: MCP entries go through the environment.
      persistDebugLog('assistant-stack', 'agent profile setup not written', {
        profile,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Set up a profile Boundary just created. The limits need a model to size them from; without
 * one applied yet the first model change writes them.
 */
export async function setUpNewHermesProfile(profile: string): Promise<void> {
  if (!(await isAssistantStackReady())) return;
  const last = getLastAppliedLlm();
  const { root } = tryResolveAssistantRoot();
  const compose = isLocalAssistantStackMode() ? runLiveLocalStackCompose : runBoundaryCompose;
  await setUpAgentProfile(
    compose,
    profile,
    last
      ? profileLimitsFor(root, rewriteLlmUrlForContainer(last.endpointUrl), last.contextLength)
      : null
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
  const local = isLocalAssistantStackMode();
  return {
    compose: local ? runLiveLocalStackCompose : runBoundaryCompose,
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

  const applied = await applyLlmConnectionToHermes();
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
  if (!getLlmConnection()) {
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

/**
 * QA helper: wipe Boundary-owned project/markers so the next ensure is first-time.
 * Refuses while local-stack mode is active (BOUNDARY_LOCAL_STACK / BOUNDARY_ASSISTANT_ROOT).
 */
export async function resetBoundaryAssistantStackInstall(options?: {
  wipeWorkspace?: boolean;
}): Promise<{ success: boolean; error?: string }> {
  if (isLocalAssistantStackMode()) {
    const error = localStackResetBlockedMessage('Assistant stack reset');
    return { success: false, error };
  }

  try {
    emitProgress('Resetting Boundary-managed assistant stack install…');
    await resetBoundaryAssistantStack({ wipeWorkspace: options?.wipeWorkspace ?? true });
    clearAssistantStackSetupComplete();
    setLifecycle(
      createLifecycleSnapshot('idle', {
        message: 'Assistant stack install reset. Run Setup to provision again.',
        services: [],
      })
    );
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/** Exported for tests */
export const __test = {
  offsetPorts,
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
  },
  getEnsureRunningPromise: () => ensureRunningPromise,
};
