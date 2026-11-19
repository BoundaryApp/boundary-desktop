/**
 * Steps of a project made from a folder on this Mac, shown in the new project sheet while
 * the create runs. Main sends the whole list on each change, keyed by the run id the
 * renderer passed in.
 */

export type ProjectCreateStepId =
  /** A coding task is running and the user chose to wait for it. */
  | 'task'
  /** Another folder change is restarting the containers. */
  | 'queue'
  /** Recreating Hermes (and the coding agent) with the folder mounted. */
  | 'mount'
  /** Waiting for the restarted containers to answer. */
  | 'health'
  /** Checking the coding agent can open the folder. */
  | 'check'
  /** Making it the active project on the gateway. */
  | 'open';

export type ProjectCreateStepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'error';

export interface ProjectCreateStep {
  id: ProjectCreateStepId;
  status: ProjectCreateStepStatus;
}

export interface ProjectCreateProgressEvent {
  runId: string;
  steps: ProjectCreateStep[];
}

/** What to do when a coding task is running: stop it, or wait for it to finish. */
export type ProjectCreateWhenBusy = 'stop' | 'wait';
