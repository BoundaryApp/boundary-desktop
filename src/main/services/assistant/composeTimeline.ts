import {
  resolveContainerFromProgressEvent,
  type ComposeProgressEvent,
} from '../../../shared/assistantStackLifecycle';

/** Distinct steps kept per container; pull layers repeat a handful of texts. */
const MAX_STEPS = 16;

export interface ComposeServiceTiming {
  /** Milliseconds from the start of the run to the first time each text appeared. */
  steps: Record<string, number>;
  last: string;
  lastMs: number;
}

/**
 * Records when each container reached each Compose status ("Pulling", "Started",
 * "Healthy"…), for the debug log's compose line. Times are relative to `startedAt`.
 */
export class ComposeTimeline {
  private readonly services: Record<string, ComposeServiceTiming> = {};

  constructor(private readonly startedAt: number = Date.now()) {}

  record(event: ComposeProgressEvent, now: number = Date.now()): void {
    const container = resolveContainerFromProgressEvent(event);
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!container || !text) return;
    const ms = now - this.startedAt;
    const timing = (this.services[container] ??= { steps: {}, last: text, lastMs: ms });
    if (!(text in timing.steps) && Object.keys(timing.steps).length < MAX_STEPS) {
      timing.steps[text] = ms;
    }
    timing.last = text;
    timing.lastMs = ms;
  }

  summary(): Record<string, ComposeServiceTiming> {
    return this.services;
  }
}
