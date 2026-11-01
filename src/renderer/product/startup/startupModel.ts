import { PROGRESS, createLifecycleSnapshot } from '../../../shared/assistantStackLifecycle';
import type { BoundaryAssistantContainerName } from '../../../shared/assistantStackLifecycle';
import type {
  AssistantStackLifecycleSnapshot,
  AssistantStackLifecycleStage,
  AssistantStackServiceProgress,
} from '../../../shared/types/assistantStack';
import {
  ESTIMATE_OVERDUE_TEXT,
  ESTIMATE_UNKNOWN_TEXT,
  estimateMinutes,
  estimateText,
  expectedServiceOffset,
  startRemaining,
  stretchFill,
  timedProgress,
  type StartTiming,
} from '../../../shared/startupTiming';

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

/**
 * How far a tool's outline has filled, 0 to 1. Like the main bar it follows time, here towards
 * when this Mac's earlier starts had the tool's last container up. What Compose has reported
 * lifts it, except during a pull: one finished layer says little about the image. Only a done
 * tool reaches 1. Callers keep a high-water mark, as for the bar.
 */
export function toolFill(
  tool: StartupTool,
  services: AssistantStackServiceProgress[],
  timing: StartTiming,
  now: number
): number {
  const mine = services.filter((s) => (tool.containers as string[]).includes(s.containerName));
  if (mine.length > 0 && mine.every((s) => s.state === 'done')) return 1;
  const expected = Math.max(...tool.containers.map((name) => expectedServiceOffset(timing, name)));
  const reported =
    mine.reduce((sum, s) => sum + (s.progress >= PROGRESS.creating ? s.progress : 0), 0) /
    tool.containers.length;
  return Math.max(stretchFill(now - timing.startedAt, expected), reported);
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

/** The lifecycle's service cards, or the queued placeholders before main has sent any. */
export function startupServices(
  lifecycle: AssistantStackLifecycleSnapshot
): AssistantStackServiceProgress[] {
  return lifecycle.services?.length > 0
    ? lifecycle.services
    : createLifecycleSnapshot('starting').services;
}

/**
 * Overall 0–1 fill, from this start's milestones (startupTiming.ts). Callers keep a high-water
 * mark so the bar never moves back (a stalled or backward bar reads as broken; Amer & Johnson 2016).
 */
export function startupProgress(
  stage: AssistantStackLifecycleStage | undefined,
  timing: StartTiming | undefined,
  now: number
): number {
  if (stage === 'ready') return 1;
  return timing ? timedProgress(timing, now) : 0.02;
}

export interface StartupEstimate {
  text: string;
  /** Loose minutes left, for the next call; absent when the line isn't a figure. */
  minutes?: number;
  /** This Mac has no finished start of this kind, so the line says nothing specific. */
  unknown?: boolean;
}

/**
 * Loose time left. `heldMinutes` is the last figure shown: a figure only steps down, so a slow
 * stretch ends in "Taking longer than usual" rather than a number that climbs.
 */
export function startupEstimate(
  timing: StartTiming,
  now: number,
  heldMinutes?: number
): StartupEstimate {
  if (!timing.fromHistory) return { text: ESTIMATE_UNKNOWN_TEXT, unknown: true };
  const { remainingMs, overdue } = startRemaining(timing, now);
  if (overdue) return { text: ESTIMATE_OVERDUE_TEXT };
  const minutes = Math.min(heldMinutes ?? Infinity, estimateMinutes(remainingMs));
  return { text: estimateText(minutes), minutes };
}
