import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProjectCreateStep,
  ProjectCreateStepId,
  ProjectCreateStepStatus,
} from '../../../shared/types/projectCreate';
import type { StepLook } from '../../components/ui/step-list';

/**
 * The steps shown the moment Create is clicked, before main's first event. Main's list
 * replaces them; it adds the wait steps when the create has to wait.
 */
function provisionalSteps(coding: boolean): ProjectCreateStep[] {
  const ids: ProjectCreateStepId[] = ['mount', 'health', ...(coding ? ['check' as const] : []), 'open'];
  return ids.map((id, index) => ({ id, status: index === 0 ? 'running' : 'pending' }));
}

/** Marks the running or waiting step failed, for a create that ended before main said so. */
function failRunningStep(steps: readonly ProjectCreateStep[]): ProjectCreateStep[] {
  if (steps.some((step) => step.status === 'error')) return [...steps];
  const current = steps.findIndex((step) => step.status === 'running' || step.status === 'waiting');
  const index = current >= 0 ? current : steps.findIndex((step) => step.status === 'pending');
  return steps.map((step, i) => (i === index ? { ...step, status: 'error' } : step));
}

export function stepLook(status: ProjectCreateStepStatus): StepLook {
  switch (status) {
    case 'done':
      return 'done';
    case 'error':
      return 'fail';
    case 'waiting':
      return 'wait';
    case 'running':
      return 'run';
    case 'pending':
      return 'pending';
  }
}

export function stepName(id: ProjectCreateStepId): string {
  switch (id) {
    case 'task':
      return 'Wait for the coding task';
    case 'queue':
      return 'Wait for another folder change';
    case 'mount':
      return 'Restart the assistant';
    case 'health':
      return 'Wait for it to answer';
    case 'check':
      return 'Check the coding agent can open the folder';
    case 'open':
      return 'Open the project';
  }
}

export function stepDetail(id: ProjectCreateStepId, coding: boolean): string {
  switch (id) {
    case 'task':
      return 'Restarting the coding agent would stop it';
    case 'queue':
      return 'One restart runs at a time';
    case 'mount':
      return coding
        ? 'With the folder mounted for the assistant and the coding agent'
        : 'With the folder mounted';
    case 'health':
      return coding ? 'The assistant and the coding agent' : 'Health check';
    case 'check':
      return 'Lists the folder from inside the coding agent';
    case 'open':
      return 'Makes it the active project';
  }
}

export function stepRight(step: ProjectCreateStep): string {
  switch (step.status) {
    case 'done':
      return 'Done';
    case 'error':
      return 'Failed';
    case 'waiting':
      return step.id === 'task' ? 'Waiting for task' : 'Queued';
    case 'running':
    case 'pending':
      return '';
  }
}

export interface ProjectCreateSteps {
  /** Null while no create is shown. */
  steps: ProjectCreateStep[] | null;
  /** Shows the provisional steps and returns the run id to pass to main. */
  begin: (coding: boolean) => string;
  /** Marks the running step failed. */
  fail: () => void;
  /** Hides the steps and ignores later events of the run. */
  clear: () => void;
}

/** The steps of the folder project being created, from main's `hermes-projects:create-progress`. */
export function useProjectCreateSteps(): ProjectCreateSteps {
  const [steps, setSteps] = useState<ProjectCreateStep[] | null>(null);
  const runRef = useRef<string | null>(null);

  useEffect(
    () =>
      window.electronAPI.projects.onCreateProgress((event) => {
        if (event.runId === runRef.current) setSteps(event.steps);
      }),
    []
  );

  const begin = useCallback((coding: boolean) => {
    const runId = crypto.randomUUID();
    runRef.current = runId;
    setSteps(provisionalSteps(coding));
    return runId;
  }, []);

  const fail = useCallback(() => {
    setSteps((current) => (current ? failRunningStep(current) : current));
  }, []);

  const clear = useCallback(() => {
    runRef.current = null;
    setSteps(null);
  }, []);

  return useMemo(() => ({ steps, begin, fail, clear }), [steps, begin, fail, clear]);
}
