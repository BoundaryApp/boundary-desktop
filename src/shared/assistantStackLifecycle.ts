import { BOUNDARY_ASSISTANT_CONTAINER_NAMES } from './assistantStackConstants';
import { ASSISTANT_UI_SERVICES } from './assistantUiServices';
import type {
  AssistantStackLifecyclePhase,
  AssistantStackLifecycleSnapshot,
  AssistantStackLifecycleStage,
  AssistantStackServiceProgress,
  AssistantStackServiceProgressState,
} from './types/assistantStack';

/** Ordered start-path stages for the checklist UI (excludes idle/error). */
export const ASSISTANT_STACK_START_STAGES: AssistantStackLifecycleStage[] = [
  'provision',
  'hostSetup',
  'hermesInit',
  'compose',
  'health',
  'configureLlm',
  'ready',
];

export const ASSISTANT_STACK_STAGE_LABELS: Record<AssistantStackLifecycleStage, string> = {
  idle: 'Idle',
  provision: 'Download stack',
  hostSetup: 'Host setup',
  hermesInit: 'Initialize Hermes',
  compose: 'Start containers',
  health: 'Health checks',
  configureLlm: 'Configure LLM',
  ready: 'Ready',
  error: 'Error',
};

/**
 * Re-emit a base message with elapsed seconds while a long op is silent.
 * Does not fire immediately (caller already emitted the base message).
 */
export function startElapsedHeartbeat(
  onTick: (message: string, elapsedSec: number) => void,
  baseMessage: string,
  intervalMs = 2_500
): () => void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    const trimmed = baseMessage.replace(/\s*…?\s*$/, '');
    onTick(`${trimmed}… ${elapsedSec}s`, elapsedSec);
  }, intervalMs);
  return () => clearInterval(timer);
}

export type BoundaryAssistantContainerName =
  (typeof BOUNDARY_ASSISTANT_CONTAINER_NAMES)[number];

/** Compose service name (base file) → Boundary container_name. */
export const COMPOSE_SERVICE_TO_CONTAINER: Record<string, BoundaryAssistantContainerName> = {
  hermes: 'boundary-hermes',
  'hermes-webui': 'boundary-hermes-webui',
  searxng: 'boundary-searxng',
  lightrag: 'boundary-lightrag',
  neo4j: 'boundary-lightrag-neo4j',
  'gpt-researcher': 'boundary-gpt-researcher',
  n8n: 'boundary-n8n',
  opencode: 'boundary-opencode',
  'opencode-mcp': 'boundary-opencode-mcp',
  'llm-proxy': 'boundary-llm-proxy',
  'hermes-worker': 'boundary-hermes-worker',
  'postgres-db': 'boundary-postgres-db',
  'sql-mcp-ro': 'boundary-sql-mcp-ro',
  'sql-mcp-rw': 'boundary-sql-mcp-rw',
};

const CONTAINER_TITLES: Record<BoundaryAssistantContainerName, string> = {
  'boundary-hermes': 'Hermes API',
  'boundary-hermes-webui': 'Hermes WebUI',
  'boundary-searxng': 'SearXNG',
  'boundary-lightrag': 'LightRAG',
  'boundary-lightrag-neo4j': 'Neo4j',
  'boundary-gpt-researcher': 'GPT Researcher',
  'boundary-n8n': 'n8n',
  'boundary-opencode': 'OpenCode',
  'boundary-opencode-mcp': 'OpenCode MCP',
  'boundary-llm-proxy': 'Model proxy',
  'boundary-hermes-worker': 'Tool worker',
  'boundary-postgres-db': 'Shared database',
  'boundary-sql-mcp-ro': 'SQL tools (read-only)',
  'boundary-sql-mcp-rw': 'SQL tools (read-write)',
};

for (const service of ASSISTANT_UI_SERVICES) {
  const mapped = COMPOSE_SERVICE_TO_CONTAINER[service.id];
  if (mapped) {
    CONTAINER_TITLES[mapped] = service.title;
  }
}

export function titleForContainer(containerName: string): string {
  return (
    CONTAINER_TITLES[containerName as BoundaryAssistantContainerName] ?? containerName
  );
}

export function seedServiceProgress(
  state: AssistantStackServiceProgressState = 'pending',
  statusText = 'Queued…',
  progress = 0.05
): AssistantStackServiceProgress[] {
  return BOUNDARY_ASSISTANT_CONTAINER_NAMES.map((containerName) => ({
    id: containerName,
    containerName,
    title: titleForContainer(containerName),
    state,
    statusText,
    progress,
  }));
}

function defaultStageForPhase(
  phase: AssistantStackLifecyclePhase
): AssistantStackLifecycleStage | undefined {
  if (phase === 'ready') return 'ready';
  if (phase === 'error') return 'error';
  if (phase === 'idle' || phase === 'stopped') return 'idle';
  return undefined;
}

export function createLifecycleSnapshot(
  phase: AssistantStackLifecyclePhase,
  options?: {
    message?: string;
    error?: string;
    services?: AssistantStackServiceProgress[];
    stage?: AssistantStackLifecycleStage;
    stageStartedAt?: number;
  }
): AssistantStackLifecycleSnapshot {
  const defaultState: AssistantStackServiceProgressState =
    phase === 'ready' || phase === 'stopped'
      ? 'done'
      : phase === 'error'
        ? 'error'
        : phase === 'idle'
          ? 'pending'
          : 'pending';
  const defaultText =
    phase === 'ready'
      ? 'Ready'
      : phase === 'stopped'
        ? 'Stopped'
        : phase === 'stopping'
          ? 'Stopping…'
              : phase === 'starting'
            ? 'Queued…'
            : phase === 'error'
              ? 'Error'
              : 'Idle';
  const defaultProgress =
    phase === 'ready' || phase === 'stopped' ? 1 : phase === 'starting' ? 0.05 : 0;

  const now = Date.now();
  const stage = options?.stage ?? defaultStageForPhase(phase);

  return {
    phase,
    stage,
    stageStartedAt: options?.stageStartedAt ?? (stage ? now : undefined),
    updatedAt: now,
    message: options?.message,
    error: options?.error,
    services:
      options?.services ??
      seedServiceProgress(defaultState, defaultText, defaultProgress),
  };
}

/**
 * Map Compose image refs (and layer parent_id) onto Boundary containers.
 * Examples: `Image gptresearcher/gpt-researcher:0.8.1`, `neo4j:5.26-community`.
 */
const IMAGE_HINTS: Array<[string, BoundaryAssistantContainerName]> = [
  ['gpt-researcher', 'boundary-gpt-researcher'],
  ['gptresearcher', 'boundary-gpt-researcher'],
  ['hermes-webui', 'boundary-hermes-webui'],
  ['nesquena/hermes-webui', 'boundary-hermes-webui'],
  ['nousresearch/hermes', 'boundary-hermes'],
  ['hermes-agent', 'boundary-hermes'],
  ['searxng/searxng', 'boundary-searxng'],
  ['searxng', 'boundary-searxng'],
  ['lightrag', 'boundary-lightrag'],
  ['neo4j', 'boundary-lightrag-neo4j'],
  ['n8nio/n8n', 'boundary-n8n'],
  // Longest hint wins, so these must outrank 'assistant-opencode', which they contain.
  ['assistant-opencode-mcp', 'boundary-opencode-mcp'],
  ['opencode-mcp', 'boundary-opencode-mcp'],
  ['assistant-llm-proxy', 'boundary-llm-proxy'],
  ['assistant-hermes-worker', 'boundary-hermes-worker'],
  ['hermes-worker', 'boundary-hermes-worker'],
  ['llm-proxy', 'boundary-llm-proxy'],
  // n8n's postgres is postgres:16, so match the shared database's major version only.
  ['postgres:18', 'boundary-postgres-db'],
  // Both SQL sidecars run one image; pull progress lands on the read-only one.
  ['postgres-mcp', 'boundary-sql-mcp-ro'],
  ['assistant-opencode', 'boundary-opencode'],
  ['opencode', 'boundary-opencode'],
];

/** Local image name fragments used to detect already-pulled images per container. */
export const CONTAINER_IMAGE_HINTS: Record<BoundaryAssistantContainerName, string[]> = {
  'boundary-hermes': ['nousresearch/hermes-agent', 'hermes-agent'],
  'boundary-hermes-webui': ['nesquena/hermes-webui', 'hermes-webui'],
  'boundary-searxng': ['searxng/searxng', 'searxng'],
  'boundary-lightrag': ['assistant-lightrag', 'lightrag'],
  'boundary-lightrag-neo4j': ['neo4j'],
  'boundary-gpt-researcher': ['gptresearcher/gpt-researcher', 'gpt-researcher'],
  'boundary-n8n': ['n8nio/n8n'],
  'boundary-opencode': ['assistant-opencode', 'opencode'],
  'boundary-opencode-mcp': ['boundary-assistant-opencode-mcp', 'opencode-mcp'],
  'boundary-llm-proxy': ['boundary-assistant-llm-proxy', 'llm-proxy'],
  'boundary-hermes-worker': ['boundary-assistant-hermes-worker', 'hermes-worker'],
  'boundary-postgres-db': ['postgres:18'],
  'boundary-sql-mcp-ro': ['crystaldba/postgres-mcp'],
  'boundary-sql-mcp-rw': ['crystaldba/postgres-mcp'],
};

/** Local-image checkpoint — not create/start progress. */
export const IMAGE_CACHED_PROGRESS = 0.2;

/** Progress ceilings for a single monotonic start bar (100% = healthy/ready). */
export const PROGRESS = {
  queued: 0.05,
  siblingQueued: 0.08,
  imageCached: IMAGE_CACHED_PROGRESS,
  pullMin: 0.2,
  pullMax: 0.55,
  pulled: 0.55,
  creating: 0.65,
  created: 0.7,
  starting: 0.8,
  started: 0.85,
  healthy: 1,
  stopping: 0.4,
  stopped: 1,
} as const;

/**
 * High-water mark for a single service fill. Never returns a value below `previous`.
 * Logs when a writer attempted a regression (dev visibility; production still clamps).
 */
export function monotonicProgress(
  previous: number,
  next: number,
  context?: string
): number {
  const prev = Number.isFinite(previous) ? previous : 0;
  const nxt = Number.isFinite(next) ? next : 0;
  if (nxt + 1e-6 < prev) {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      console.error('[assistant-stack] progress regression blocked', {
        previous: prev,
        next: nxt,
        context: context ?? 'unknown',
      });
    }
    return prev;
  }
  return Math.max(prev, nxt);
}

export function mergeServiceProgress(
  existing: AssistantStackServiceProgress,
  patch: Partial<AssistantStackServiceProgress> &
    Pick<AssistantStackServiceProgress, 'progress'>,
  context?: string
): AssistantStackServiceProgress {
  return {
    ...existing,
    ...patch,
    id: existing.id,
    containerName: existing.containerName,
    title: existing.title,
    progress: monotonicProgress(
      existing.progress,
      patch.progress,
      context ?? `merge:${existing.containerName}`
    ),
  };
}

/** Merge incoming service list onto previous by container id; progress never decreases. */
export function mergeServicesById(
  previous: AssistantStackServiceProgress[],
  incoming: AssistantStackServiceProgress[],
  context?: string
): AssistantStackServiceProgress[] {
  const prevById = new Map(previous.map((s) => [s.containerName, s]));
  const seen = new Set<string>();
  const merged = incoming.map((next) => {
    seen.add(next.containerName);
    const prev = prevById.get(next.containerName);
    if (!prev) return next;
    return mergeServiceProgress(prev, next, context ?? 'mergeServicesById');
  });
  for (const prev of previous) {
    if (!seen.has(prev.containerName)) {
      merged.push(prev);
    }
  }
  // Preserve stable catalog order when possible.
  const order = new Map(
    BOUNDARY_ASSISTANT_CONTAINER_NAMES.map((name, i) => [name, i])
  );
  merged.sort(
    (a, b) => (order.get(a.containerName as BoundaryAssistantContainerName) ?? 99) -
      (order.get(b.containerName as BoundaryAssistantContainerName) ?? 99)
  );
  return merged;
}

/**
 * True when progress high-water may reset (new start ensure or enter stop wave).
 * Same-wave updates (e.g. starting→ready, stopping→stopped) must merge fills.
 */
export function isLifecycleWaveBoundary(
  from: AssistantStackLifecyclePhase,
  to: AssistantStackLifecyclePhase
): boolean {
  const startish = (p: AssistantStackLifecyclePhase): boolean =>
    p === 'idle' || p === 'starting' || p === 'ready' || p === 'error';
  const stopish = (p: AssistantStackLifecyclePhase): boolean =>
    p === 'stopping' || p === 'stopped';
  if (startish(from) && stopish(to)) return true;
  if (stopish(from) && startish(to)) return true;
  // New ensure seed from a terminal / idle start phase.
  if ((from === 'idle' || from === 'ready' || from === 'error') && to === 'starting') {
    return true;
  }
  return false;
}

/** True when a card is mid pull/create/start (not terminal Pulled / cached / waiting). */
function isActivelyBusyService(s: AssistantStackServiceProgress): boolean {
  if (s.state === 'done' || s.state === 'error') return false;
  if (/^pulled$/i.test(s.statusText)) return false;
  if (/^image (ready|cached)/i.test(s.statusText)) return false;
  if (/^waiting to start/i.test(s.statusText)) return false;
  if (/^queued/i.test(s.statusText)) return false;
  return (
    (s.state === 'working' || s.progress >= PROGRESS.creating) &&
    /download|pull|extract|creat|start|healthy|ready|configur/i.test(s.statusText)
  );
}

/** Mark still-idle / image-cached / Pulled cards while a peer is actively pulling or starting. */
export function markSiblingServicesQueued(
  services: AssistantStackServiceProgress[]
): AssistantStackServiceProgress[] {
  const anyBusy = services.some(isActivelyBusyService);
  if (!anyBusy) return services;

  return services.map((service) => {
    if (service.state === 'done' || service.state === 'error') {
      return service;
    }
    if (isActivelyBusyService(service)) {
      return service;
    }
    const pullDone =
      /^pulled$/i.test(service.statusText) || service.progress >= PROGRESS.pulled;
    const hadCachedImage =
      pullDone ||
      /^image (ready|cached)/i.test(service.statusText) ||
      /^waiting to start/i.test(service.statusText) ||
      service.progress >= IMAGE_CACHED_PROGRESS;
    const floor = pullDone
      ? PROGRESS.pulled
      : hadCachedImage
        ? IMAGE_CACHED_PROGRESS
        : PROGRESS.siblingQueued;
    return {
      ...service,
      state: 'pending',
      statusText: hadCachedImage
        ? 'Waiting to start…'
        : 'Queued — waiting on other images…',
      // Raise-to-floor only — never overwrite a higher fill with IMAGE_CACHED_PROGRESS.
      progress: monotonicProgress(
        service.progress,
        Math.max(service.progress, floor),
        `siblingQueued:${service.containerName}`
      ),
    };
  });
}

/** Apply local `docker images` listing onto seed cards (Image cached vs still Queued). */
export function applyLocalImageListing(
  services: AssistantStackServiceProgress[],
  imageLines: string[]
): AssistantStackServiceProgress[] {
  const lower = imageLines.map((line) => line.trim().toLowerCase()).filter(Boolean);
  return services.map((service) => {
    const hints =
      CONTAINER_IMAGE_HINTS[service.containerName as BoundaryAssistantContainerName] ?? [];
    const present = hints.some((hint) => lower.some((img) => img.includes(hint)));
    if (!present) {
      return mergeServiceProgress(
        service,
        {
          state: 'pending',
          statusText: service.progress > 0.1 ? service.statusText : 'Queued…',
          progress: PROGRESS.queued,
        },
        `localImages:missing:${service.containerName}`
      );
    }
    if (service.state === 'done' || service.progress >= 0.75) {
      return service;
    }
    return mergeServiceProgress(
      service,
      {
        state: 'pending',
        statusText: 'Image cached',
        progress: IMAGE_CACHED_PROGRESS,
      },
      `localImages:cached:${service.containerName}`
    );
  });
}

export function resolveContainerFromImageRef(
  rawRef: string | undefined | null
): BoundaryAssistantContainerName | null {
  if (!rawRef) return null;
  const lower = rawRef.trim().toLowerCase().replace(/^image\s+/i, '');
  const hints = [...IMAGE_HINTS].sort((a, b) => b[0].length - a[0].length);
  for (const [hint, container] of hints) {
    if (lower.includes(hint)) {
      return container;
    }
  }
  return null;
}

/**
 * Resolve a Compose progress event id / service name onto a Boundary container.
 * Accepts forms like `Container boundary-hermes`, `boundary-hermes`, `hermes`,
 * and image refs like `Image gptresearcher/gpt-researcher:0.8.1`.
 */
export function resolveContainerFromProgressId(
  rawId: string | undefined | null
): BoundaryAssistantContainerName | null {
  if (!rawId) return null;
  const trimmed = rawId.trim();
  const withoutPrefix = trimmed.replace(/^(Container|Image|Network|Volume)\s+/i, '');

  // Prefer longer names first so `boundary-hermes-webui` does not match `boundary-hermes`.
  const namesByLength = [...BOUNDARY_ASSISTANT_CONTAINER_NAMES].sort(
    (a, b) => b.length - a.length
  );
  for (const name of namesByLength) {
    if (
      withoutPrefix === name ||
      withoutPrefix.endsWith(`/${name}`) ||
      withoutPrefix.endsWith(`_${name}`) ||
      withoutPrefix.endsWith(`-${name}`)
    ) {
      return name;
    }
  }

  const serviceKey = withoutPrefix.toLowerCase();
  if (serviceKey in COMPOSE_SERVICE_TO_CONTAINER) {
    return COMPOSE_SERVICE_TO_CONTAINER[serviceKey];
  }

  // Compose sometimes reports "project-service-1" — match longest service key first.
  const servicesByLength = Object.entries(COMPOSE_SERVICE_TO_CONTAINER).sort(
    (a, b) => b[0].length - a[0].length
  );
  for (const [service, container] of servicesByLength) {
    if (
      serviceKey === service ||
      serviceKey.endsWith(`-${service}`) ||
      serviceKey.includes(`-${service}-`) ||
      serviceKey.endsWith(`_${service}`)
    ) {
      return container;
    }
  }

  // Image pull / build refs (also used via parent_id on layer events).
  if (/^image\s+/i.test(trimmed) || trimmed.includes('/') || trimmed.includes(':')) {
    return resolveContainerFromImageRef(trimmed);
  }

  return null;
}

export type ComposeProgressEventStatus = 'Working' | 'Done' | 'Error' | string;

export interface ComposeProgressEvent {
  id?: string;
  parent_id?: string;
  status?: ComposeProgressEventStatus;
  text?: string;
  details?: string;
  current?: number;
  total?: number;
  percent?: number;
  /** Some Compose builds use `Resource` / nested shapes — keep loose. */
  [key: string]: unknown;
}

export function progressFromComposeText(
  status: string | undefined,
  text: string | undefined,
  options?: {
    imagePull?: boolean;
    percent?: number | null;
    current?: number | null;
    total?: number | null;
    /** When true, treat terminal stop events as 100% done. */
    stopping?: boolean;
  }
): { state: AssistantStackServiceProgressState; progress: number; statusText: string } {
  const statusNorm = (status ?? '').toLowerCase();
  const textNorm = (text ?? '').trim();
  const label = textNorm || statusNorm || 'Updating…';
  const lower = label.toLowerCase();

  if (statusNorm === 'error' || lower.includes('error') || lower.includes('fail')) {
    return { state: 'error', progress: 1, statusText: label };
  }

  // Image / layer pulls: stay in the pull band; never service-complete.
  if (options?.imagePull) {
    let fraction: number | null = null;
    if (
      typeof options.percent === 'number' &&
      Number.isFinite(options.percent) &&
      options.percent >= 0
    ) {
      fraction = Math.min(1, options.percent / 100);
    } else if (
      typeof options.current === 'number' &&
      typeof options.total === 'number' &&
      options.total > 0
    ) {
      fraction = Math.min(1, options.current / options.total);
    }

    if (statusNorm === 'done' && (lower.includes('pulled') || lower === 'pulled')) {
      return { state: 'working', progress: PROGRESS.pulled, statusText: 'Pulled' };
    }
    if (lower.includes('download') || lower.includes('extract') || lower.includes('pull')) {
      const progress =
        fraction != null
          ? PROGRESS.pullMin + fraction * (PROGRESS.pullMax - PROGRESS.pullMin)
          : lower.includes('download')
            ? 0.4
            : 0.28;
      const pctLabel =
        fraction != null ? `Downloading ${Math.round(fraction * 100)}%` : label;
      return {
        state: 'working',
        progress: Math.min(PROGRESS.pullMax, progress),
        statusText: lower.includes('download') ? pctLabel : label,
      };
    }
    if (lower.includes('already exists') || lower.includes('waiting')) {
      return { state: 'working', progress: PROGRESS.imageCached, statusText: label };
    }
    if (statusNorm === 'done') {
      return { state: 'working', progress: PROGRESS.pulled, statusText: label };
    }
    return { state: 'working', progress: 0.3, statusText: label };
  }

  // Stop / remove terminal.
  if (lower.includes('stopped') || lower === 'removed' || lower.includes('removed')) {
    return { state: 'done', progress: PROGRESS.stopped, statusText: label };
  }
  if (lower.includes('stopp') || lower.includes('remov')) {
    return { state: 'working', progress: PROGRESS.stopping, statusText: label };
  }

  // Healthy is the only start-path 100%.
  if (lower === 'healthy' || lower.includes('healthy')) {
    return { state: 'done', progress: PROGRESS.healthy, statusText: 'Healthy' };
  }

  if (lower === 'created' || (statusNorm === 'done' && lower.includes('creat'))) {
    return { state: 'working', progress: PROGRESS.created, statusText: 'Created' };
  }
  if (lower.includes('creat')) {
    return { state: 'working', progress: PROGRESS.creating, statusText: label };
  }

  if (lower === 'started' || (statusNorm === 'done' && lower.includes('start'))) {
    // No healthcheck services may never emit Healthy; Started is near-complete.
    // Callers that know Healthy is coming keep this as working @ 0.85.
    return { state: 'working', progress: PROGRESS.started, statusText: 'Started' };
  }
  if (lower.includes('start')) {
    return { state: 'working', progress: PROGRESS.starting, statusText: label };
  }

  if (lower.includes('wait')) {
    return { state: 'working', progress: PROGRESS.siblingQueued, statusText: label };
  }

  if (
    lower.includes('pull') ||
    lower.includes('download') ||
    lower.includes('extract')
  ) {
    return { state: 'working', progress: 0.35, statusText: label };
  }

  if (statusNorm === 'done' && (lower === 'built' || lower.includes('built'))) {
    return { state: 'working', progress: PROGRESS.pulled, statusText: label };
  }

  if (statusNorm === 'working') {
    return { state: 'working', progress: 0.55, statusText: label };
  }

  return { state: 'working', progress: 0.45, statusText: label };
}

function eventLooksLikeImagePull(event: ComposeProgressEvent): boolean {
  const id = typeof event.id === 'string' ? event.id : '';
  const parent = typeof event.parent_id === 'string' ? event.parent_id : '';
  return (
    /^image\s+/i.test(id) ||
    /^image\s+/i.test(parent) ||
    Boolean(parent) ||
    /pull|download|extract|fs layer|checksum/i.test(String(event.text ?? ''))
  );
}

export function resolveContainerFromProgressEvent(
  event: ComposeProgressEvent
): BoundaryAssistantContainerName | null {
  const id = typeof event.id === 'string' ? event.id : undefined;
  const parentId = typeof event.parent_id === 'string' ? event.parent_id : undefined;
  return (
    resolveContainerFromProgressId(id) ??
    resolveContainerFromImageRef(parentId) ??
    resolveContainerFromImageRef(id) ??
    null
  );
}

export function applyComposeProgressEvent(
  services: AssistantStackServiceProgress[],
  event: ComposeProgressEvent
): AssistantStackServiceProgress[] {
  const container = resolveContainerFromProgressEvent(event);
  if (!container) {
    return services;
  }

  const imagePull = eventLooksLikeImagePull(event);
  const mapped = progressFromComposeText(
    typeof event.status === 'string' ? event.status : undefined,
    typeof event.text === 'string' ? event.text : undefined,
    {
      imagePull,
      percent: typeof event.percent === 'number' ? event.percent : null,
      current: typeof event.current === 'number' ? event.current : null,
      total: typeof event.total === 'number' ? event.total : null,
    }
  );

  return markSiblingServicesQueued(
    services.map((service) => {
      if (service.containerName !== container) {
        return service;
      }
      if (service.state === 'done' && mapped.state === 'working') {
        // Never regress a completed service.
        return service;
      }

      // Pull-band: never raise past pullMax from layer events; never lower fill.
      let proposed = mapped.progress;
      if (imagePull && mapped.state === 'working') {
        const capped = Math.min(mapped.progress, PROGRESS.pullMax);
        if (service.progress > PROGRESS.pullMax) {
          // Already past pull (create/start); ignore late layer events for fill.
          proposed = service.progress;
        } else {
          proposed = capped;
        }
      }

      return mergeServiceProgress(
        service,
        {
          state: mapped.state,
          statusText: mapped.statusText,
          progress: proposed,
        },
        `compose:${container}:${mapped.statusText}`
      );
    })
  );
}

/**
 * After compose up + Hermes health: Hermes → 100% Healthy; any card already at
 * Started (≥0.85) → 100% Ready (Compose waited on healthchecks where defined).
 */
export function markStackReadyAfterEnsure(
  services: AssistantStackServiceProgress[]
): AssistantStackServiceProgress[] {
  return services.map((service) => {
    if (service.containerName === 'boundary-hermes') {
      return mergeServiceProgress(
        service,
        {
          state: 'done',
          statusText: 'Healthy',
          progress: 1,
        },
        'readyAfterEnsure:hermes'
      );
    }
    if (service.state === 'done' || service.progress >= PROGRESS.started) {
      return mergeServiceProgress(
        service,
        {
          state: 'done',
          statusText: service.statusText === 'Healthy' ? 'Healthy' : 'Ready',
          progress: 1,
        },
        `readyAfterEnsure:${service.containerName}`
      );
    }
    return service;
  });
}

/** Parse one NDJSON / JSON line from `compose --progress=json`. */
export function parseComposeProgressLine(line: string): ComposeProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as ComposeProgressEvent;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    // Unwrap occasional `{ "resource": { id, status, text } }` shapes.
    if (
      parsed.resource &&
      typeof parsed.resource === 'object' &&
      !Array.isArray(parsed.resource)
    ) {
      return { ...parsed, ...(parsed.resource as ComposeProgressEvent) };
    }
    return parsed;
  } catch {
    return null;
  }
}

