import {
  resolveContainerFromProgressId,
  type ComposeProgressEvent,
} from '../../../shared/assistantStackLifecycle';
import {
  expectedOffsets,
  expectedServiceOffsets,
  type StartKind,
  type StartMilestone,
  type StartOffsets,
  type StartTiming,
} from '../../../shared/startupTiming';

/** Tracks one stack start's milestones against the earlier starts of its kind. */
export class StartTimer {
  private readonly reached: StartOffsets = {};
  private readonly services: Record<string, number> = {};

  constructor(
    private kind: StartKind,
    private readonly earlierRuns: (kind: StartKind) => StartOffsets[],
    private readonly startedAt: number = Date.now()
  ) {}

  /** The kind can change once the start has seen which containers exist. */
  setKind(kind: StartKind): void {
    this.kind = kind;
  }

  /** Marks a milestone the first time it happens. Returns whether this call was the first. */
  reach(milestone: StartMilestone, now: number = Date.now()): boolean {
    if (this.reached[milestone] !== undefined) return false;
    this.reached[milestone] = now - this.startedAt;
    return true;
  }

  /**
   * Compose reports `Exited` for a one-shot only while a dependent waits on it, and `Started`
   * for Hermes after both bootstraps have finished. The first run's pull ends at the first
   * `Started`. A container's own time is its latest `Started` or `Healthy`, so a one-shot sharing
   * its name gives way to the service, and a health check counts when Compose waits on one.
   */
  noteComposeEvent(event: ComposeProgressEvent, now: number = Date.now()): boolean {
    const id = typeof event.id === 'string' ? event.id : '';
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if ((text === 'Started' || text === 'Healthy') && !id.includes('bootstrap')) {
      const container = resolveContainerFromProgressId(id);
      if (container) this.services[container] = now - this.startedAt;
    }
    if (text === 'Exited') {
      if (id.includes('hermes-api-bootstrap')) return this.reach('apiBootstrapDone', now);
      if (id.includes('hermes-browser-bootstrap')) return this.reach('browserBootstrapDone', now);
      return false;
    }
    if (text !== 'Started') return false;
    const first = this.reach('toolsStarting', now);
    const isHermes = !id.includes('bootstrap') && resolveContainerFromProgressId(id) === 'boundary-hermes';
    return (isHermes && this.reach('hermesStarted', now)) || first;
  }

  timing(): StartTiming {
    const runs = this.earlierRuns(this.kind);
    return {
      startedAt: this.startedAt,
      kind: this.kind,
      expected: expectedOffsets(this.kind, runs),
      expectedServices: expectedServiceOffsets(runs),
      reached: { ...this.reached, services: { ...this.services } },
      fromHistory: runs.length > 0,
    };
  }
}
