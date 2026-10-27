import { PROGRESS, createLifecycleSnapshot } from '../../../shared/assistantStackLifecycle';
import type { BoundaryAssistantContainerName } from '../../../shared/assistantStackLifecycle';
import type {
  AssistantStackLifecycleSnapshot,
  AssistantStackLifecycleStage,
  AssistantStackServiceProgress,
} from '../../../shared/types/assistantStack';

/**
 * What the start-up screen shows (ADR 0029): the stack's containers grouped
 * into the tools a user gets, plain-language stage copy, and one bar.
 */

export type StartupToolId =
  | 'assistant'
  | 'model'
  | 'search'
  | 'memory'
  | 'research'
  | 'automations'
  | 'database'
  | 'coding';

export type StartupToolState = 'pending' | 'working' | 'done' | 'error';

export interface StartupTool {
  id: StartupToolId;
  /** Tile label. */
  label: string;
  /** Story card title. */
  title: string;
  /** Story card body: what the user gets from it. */
  benefit: string;
  containers: BoundaryAssistantContainerName[];
}

export const STARTUP_TOOLS: readonly StartupTool[] = [
  {
    id: 'assistant',
    label: 'Assistant',
    title: 'Your assistant',
    benefit:
      'Chats with you, plans the work and uses the tools around it. Commands it runs happen in a separate container, not directly on your Mac.',
    containers: ['boundary-hermes', 'boundary-hermes-webui', 'boundary-hermes-worker'],
  },
  {
    id: 'search',
    label: 'Search',
    title: 'Private web search',
    benefit:
      'Asks many search engines at once from this Mac, with no account or ad profile attached to what you look up.',
    containers: ['boundary-searxng'],
  },
  {
    id: 'research',
    label: 'Research',
    title: 'Deep research',
    benefit: 'Reads dozens of sources on a question and writes you a report with citations.',
    containers: ['boundary-gpt-researcher'],
  },
  {
    id: 'memory',
    label: 'Memory',
    title: 'Long-term memory',
    benefit:
      'Builds a knowledge graph from what you share, so answers can connect ideas across your documents.',
    containers: ['boundary-lightrag', 'boundary-lightrag-neo4j'],
  },
  {
    id: 'automations',
    label: 'Automations',
    title: 'Automations',
    benefit: 'Workflows that run on a schedule or when something happens, without you asking each time.',
    containers: ['boundary-n8n'],
  },
  {
    id: 'database',
    label: 'Database',
    title: 'A shared database',
    benefit:
      'Lets your agents keep tables of their own and query them, so the records they track stay in one place.',
    containers: ['boundary-postgres-db', 'boundary-sql-mcp-ro', 'boundary-sql-mcp-rw'],
  },
  {
    id: 'coding',
    label: 'Coding',
    title: 'A coding agent',
    benefit: 'Writes, runs and fixes code in the folders you choose.',
    containers: ['boundary-opencode', 'boundary-opencode-mcp'],
  },
  {
    id: 'model',
    label: 'Model',
    title: 'Your model connection',
    benefit:
      'Routes every tool to the model you picked. Your key stays in memory and is never written to disk.',
    containers: ['boundary-llm-proxy'],
  },
];

export function toolState(
  tool: StartupTool,
  services: AssistantStackServiceProgress[]
): StartupToolState {
  const mine = services.filter((s) => (tool.containers as string[]).includes(s.containerName));
  if (mine.length === 0) return 'pending';
  if (mine.some((s) => s.state === 'error')) return 'error';
  if (mine.every((s) => s.state === 'done')) return 'done';
  if (mine.some((s) => s.state === 'working' || s.progress > PROGRESS.siblingQueued)) {
    return 'working';
  }
  return 'pending';
}

export type StartupVariant = 'first-run' | 'launch';

const STAGE_COPY: Partial<Record<AssistantStackLifecycleStage, string>> = {
  provision: 'Downloading your tools',
  hostSetup: 'Setting things up on this Mac',
  hermesInit: 'Preparing your assistant',
  compose: 'Starting your tools',
  health: 'Making sure everything works',
  configureLlm: 'Connecting your model',
  ready: 'Ready',
};

export function stageCopy(
  stage: AssistantStackLifecycleStage | undefined,
  variant: StartupVariant
): string {
  // On later launches the provision stage only checks what is already downloaded.
  if (stage === 'provision' && variant === 'launch') return 'Checking your tools';
  return (stage && STAGE_COPY[stage]) ?? 'Getting ready';
}

/** Shown under the stage line once one stage has run this long. */
export const SLOW_STAGE_MS = 60_000;

export function slowStageHint(stage: AssistantStackLifecycleStage | undefined): string {
  return stage === 'provision' || stage === 'compose'
    ? 'Still going. Downloads take longer on slower connections.'
    : 'Still going. This step can take a minute.';
}

/** Bar span per stage. Compose and health share one span driven by the containers. */
const SPANS: Partial<Record<AssistantStackLifecycleStage, [number, number, number]>> = {
  // [start, end, time constant in ms for stages without real progress]
  provision: [0, 0.22, 40_000],
  hostSetup: [0.22, 0.32, 15_000],
  hermesInit: [0.32, 0.37, 10_000],
  configureLlm: [0.9, 0.98, 8_000],
};
const SERVICES_SPAN: [number, number] = [0.37, 0.9];

/** Time-based fill for a stage that reports nothing measurable; never reaches the end. */
function creep(msInStage: number, tau: number): number {
  return 0.9 * (1 - Math.exp(-Math.max(0, msInStage) / tau));
}

/** The lifecycle's service cards, or the queued placeholders before main has sent any. */
export function startupServices(
  lifecycle: AssistantStackLifecycleSnapshot
): AssistantStackServiceProgress[] {
  return lifecycle.services?.length > 0
    ? lifecycle.services
    : createLifecycleSnapshot('starting').services;
}

/**
 * Overall 0–1 fill. Callers keep a high-water mark so the bar never moves back
 * (a stalled or backward bar reads as broken; Amer & Johnson 2016).
 */
export function startupProgress(
  stage: AssistantStackLifecycleStage | undefined,
  services: AssistantStackServiceProgress[],
  msInStage: number
): number {
  if (stage === 'ready') return 1;
  if (stage === 'compose' || stage === 'health') {
    const mean = services.length
      ? services.reduce((sum, s) => sum + Math.min(1, Math.max(0, s.progress)), 0) /
        services.length
      : 0;
    const [start, end] = SERVICES_SPAN;
    const fraction = Math.max(mean, creep(msInStage, 60_000) * 0.5);
    return start + (end - start) * Math.min(0.98, fraction);
  }
  const span = stage ? SPANS[stage] : undefined;
  if (!span) return 0.02;
  const [start, end, tau] = span;
  return start + (end - start) * creep(msInStage, tau);
}
