import type {
  ProjectCreateProgressEvent,
  ProjectCreateStep,
  ProjectCreateStepId,
  ProjectCreateStepStatus,
} from '../../../../shared/types/projectCreate';
import { broadcast } from '../../windows';

type Emit = (event: ProjectCreateProgressEvent) => void;

let emit: Emit = (event) => broadcast('hermes-projects:create-progress', event);

/** Test-only: capture events instead of broadcasting them. Null restores the broadcast. */
export function setProjectCreateEmitForTests(next: Emit | null): void {
  emit = next ?? ((event) => broadcast('hermes-projects:create-progress', event));
}

/**
 * The step list for one create. Each change sends the whole list, so a renderer that
 * missed an event still shows the right state on the next one. Without a run id nothing
 * is sent (callers other than the new project sheet).
 */
export class ProjectCreateSteps {
  private readonly steps: ProjectCreateStep[];

  constructor(
    private readonly runId: string | undefined,
    ids: readonly ProjectCreateStepId[]
  ) {
    this.steps = ids.map((id) => ({ id, status: 'pending' }));
    this.send();
  }

  has(id: ProjectCreateStepId): boolean {
    return this.steps.some((step) => step.id === id);
  }

  start(id: ProjectCreateStepId): void {
    this.set(id, 'running');
  }

  wait(id: ProjectCreateStepId): void {
    this.set(id, 'waiting');
  }

  done(id: ProjectCreateStepId): void {
    this.set(id, 'done');
  }

  /** Marks the step that is running or waiting as failed. */
  fail(): void {
    const current = this.steps.find(
      (step) => step.status === 'running' || step.status === 'waiting'
    );
    if (current) this.set(current.id, 'error');
  }

  failStep(id: ProjectCreateStepId): void {
    this.set(id, 'error');
  }

  private set(id: ProjectCreateStepId, status: ProjectCreateStepStatus): void {
    const step = this.steps.find((row) => row.id === id);
    if (!step || step.status === status) return;
    step.status = status;
    this.send();
  }

  private send(): void {
    if (!this.runId) return;
    emit({ runId: this.runId, steps: this.steps.map((step) => ({ ...step })) });
  }
}
