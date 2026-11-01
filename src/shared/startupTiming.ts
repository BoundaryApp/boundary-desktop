/**
 * Start-up timing (ADR 0029): the milestones a stack start passes, how long earlier starts took
 * to reach each, and the bar position and loose estimate that follow from them. Milestones are
 * offsets in milliseconds from the start of the run.
 */

export const START_MILESTONES = [
  'prepared',
  'toolsStarting',
  'apiBootstrapDone',
  'browserBootstrapDone',
  'hermesStarted',
  'stackUp',
] as const;

export type StartMilestone = (typeof START_MILESTONES)[number];

/** Starts of one kind take about as long as each other; the kinds differ by minutes. */
export type StartKind = 'firstRun' | 'newContainers' | 'relaunch';

/** Per container, when Compose last reported it `Started` or `Healthy` in that start. */
export type ServiceOffsets = Partial<Record<string, number>>;

export type StartOffsets = Partial<Record<StartMilestone, number>> & { services?: ServiceOffsets };

export interface StartTiming {
  /** Epoch ms the start began. */
  startedAt: number;
  kind: StartKind;
  expected: Record<StartMilestone, number>;
  /** Containers earlier starts timed; any other falls back to SERVICE_MILESTONE. */
  expectedServices: ServiceOffsets;
  reached: StartOffsets;
  /** False until this Mac has finished a start of this kind; the defaults are only a guess. */
  fromHistory: boolean;
}

/** Earlier starts kept per kind. */
export const START_HISTORY_RUNS = 5;

/** Where the bar stands when the stack is up; the rest is for connecting the model. */
export const STACK_UP_PROGRESS = 0.97;

const SECOND = 1_000;

/** From rc.13 on Docker: 267s to the stack being up with new containers. */
const DEFAULT_OFFSETS: Record<StartKind, Record<StartMilestone, number>> = {
  firstRun: {
    prepared: 120 * SECOND,
    toolsStarting: 420 * SECOND,
    apiBootstrapDone: 545 * SECOND,
    browserBootstrapDone: 630 * SECOND,
    hermesStarted: 632 * SECOND,
    stackUp: 690 * SECOND,
  },
  newContainers: {
    prepared: 1 * SECOND,
    toolsStarting: 3 * SECOND,
    apiBootstrapDone: 128 * SECOND,
    browserBootstrapDone: 213 * SECOND,
    hermesStarted: 215 * SECOND,
    stackUp: 267 * SECOND,
  },
  relaunch: {
    prepared: 1 * SECOND,
    toolsStarting: 3 * SECOND,
    apiBootstrapDone: 128 * SECOND,
    browserBootstrapDone: 195 * SECOND,
    hermesStarted: 197 * SECOND,
    stackUp: 220 * SECOND,
  },
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The median offset of each milestone over earlier runs, or the defaults with none. A milestone
 * no run reported takes the one before it, so it adds nothing to the bar.
 */
export function expectedOffsets(
  kind: StartKind,
  runs: StartOffsets[]
): Record<StartMilestone, number> {
  const usable = runs.filter((run) => run.stackUp !== undefined);
  if (usable.length === 0) return DEFAULT_OFFSETS[kind];
  const expected = {} as Record<StartMilestone, number>;
  let previous = 0;
  for (const milestone of START_MILESTONES) {
    const seen = usable.flatMap((run): number[] => {
      const offset = run[milestone];
      return offset === undefined ? [] : [offset];
    });
    previous = Math.max(previous, seen.length > 0 ? median(seen) : previous);
    expected[milestone] = previous;
  }
  return expected;
}

/** The median time each container came up over earlier runs. */
export function expectedServiceOffsets(runs: StartOffsets[]): ServiceOffsets {
  const seen = new Map<string, number[]>();
  for (const run of runs) {
    for (const [container, offset] of Object.entries(run.services ?? {})) {
      if (offset !== undefined) seen.set(container, [...(seen.get(container) ?? []), offset]);
    }
  }
  return Object.fromEntries([...seen].map(([container, offsets]) => [container, median(offsets)]));
}

/**
 * The milestone by which a container is typically up, for one this Mac hasn't timed: the stack's
 * compose file makes Hermes wait for the tools' health checks, and the WebUI for Hermes.
 */
const SERVICE_MILESTONE: Partial<Record<string, StartMilestone>> = {
  'boundary-llm-proxy': 'apiBootstrapDone',
  'boundary-searxng': 'apiBootstrapDone',
  'boundary-postgres-db': 'apiBootstrapDone',
  'boundary-lightrag-neo4j': 'apiBootstrapDone',
  'boundary-lightrag': 'browserBootstrapDone',
  'boundary-gpt-researcher': 'browserBootstrapDone',
  'boundary-n8n': 'browserBootstrapDone',
  'boundary-opencode': 'browserBootstrapDone',
  'boundary-opencode-mcp': 'browserBootstrapDone',
  'boundary-sql-mcp-ro': 'browserBootstrapDone',
  'boundary-sql-mcp-rw': 'browserBootstrapDone',
  'boundary-hermes-worker': 'browserBootstrapDone',
  'boundary-hermes': 'hermesStarted',
};

export function expectedServiceOffset(timing: StartTiming, container: string): number {
  return (
    timing.expectedServices[container] ??
    timing.expected[SERVICE_MILESTONE[container] ?? 'stackUp']
  );
}

/** The furthest milestone reached, and when. */
function latestReached(timing: StartTiming): { index: number; at: number } | null {
  for (let index = START_MILESTONES.length - 1; index >= 0; index--) {
    const at = timing.reached[START_MILESTONES[index]];
    if (at !== undefined) return { index, at };
  }
  return null;
}

/** Share of a stretch shown once it is running late; the rest eases in and never arrives. */
const ON_TIME_SHARE = 0.85;

export function stretchFill(elapsed: number, length: number): number {
  if (length <= 0) return 0;
  const onTime = length * ON_TIME_SHARE;
  if (elapsed <= onTime) return Math.max(0, elapsed) / length;
  return ON_TIME_SHARE + (1 - ON_TIME_SHARE) * 0.9 * (1 - Math.exp(-(elapsed - onTime) / length));
}

/**
 * Bar position, 0 to STACK_UP_PROGRESS. Each stretch between milestones takes the share of the
 * bar that it takes of a typical start, so the fill follows time rather than a count of
 * containers. A slow stretch stops short of its milestone, and a fast one jumps ahead when the
 * milestone arrives.
 */
export function timedProgress(timing: StartTiming, now: number): number {
  const expected = START_MILESTONES.map((milestone) => timing.expected[milestone]);
  const total = expected.at(-1) ?? 0;
  if (total <= 0) return 0;
  const latest = latestReached(timing);
  const from = latest ? expected[latest.index] : 0;
  const fromAt = latest ? latest.at : 0;
  const next = expected.slice((latest?.index ?? -1) + 1).find((offset) => offset > from);
  if (next === undefined) return STACK_UP_PROGRESS;
  const elapsed = now - timing.startedAt - fromAt;
  const position = from + (next - from) * stretchFill(elapsed, next - from);
  return (position / total) * STACK_UP_PROGRESS;
}

/** Below this, a milestone's timing says too little about how this run is going. */
const MIN_PACE_SAMPLE_MS = 20 * SECOND;
const MIN_PACE = 0.7;
const MAX_PACE = 2;
const MIN_OVERDUE_MS = 30 * SECOND;

/**
 * What is left, worked out at the latest milestone: the typical remainder, scaled by how this
 * run compares so far.
 */
export function startRemaining(
  timing: StartTiming,
  now: number
): { remainingMs: number; overdue: boolean } {
  const latest = latestReached(timing);
  const typical = latest ? timing.expected[START_MILESTONES[latest.index]] : 0;
  const pace =
    latest && typical >= MIN_PACE_SAMPLE_MS
      ? Math.min(MAX_PACE, Math.max(MIN_PACE, latest.at / typical))
      : 1;
  const atCheckpoint = (timing.expected.stackUp - typical) * pace;
  const remainingMs = atCheckpoint - (now - timing.startedAt - (latest?.at ?? 0));
  return {
    remainingMs,
    overdue: remainingMs < -Math.max(MIN_OVERDUE_MS, atCheckpoint * 0.25),
  };
}

/** Loose size of what is left: 0 almost done, 1 about a minute, 2 a couple, else minutes. */
export function estimateMinutes(remainingMs: number): number {
  if (remainingMs < 30 * SECOND) return 0;
  if (remainingMs < 90 * SECOND) return 1;
  if (remainingMs < 180 * SECOND) return 2;
  return Math.round(remainingMs / (60 * SECOND));
}

export function estimateText(minutes: number): string {
  if (minutes <= 0) return 'Almost ready';
  if (minutes === 1) return 'About a minute left';
  if (minutes === 2) return 'A couple of minutes left';
  return `About ${minutes} minutes left`;
}

export const ESTIMATE_UNKNOWN_TEXT = 'This usually takes a few minutes';
export const ESTIMATE_OVERDUE_TEXT = 'Taking longer than usual';
