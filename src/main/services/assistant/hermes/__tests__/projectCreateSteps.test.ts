import { beforeEach, describe, expect, it, vi } from 'vitest';

const broadcast = vi.hoisted(() => vi.fn());
vi.mock('../../../windows', () => ({ broadcast }));

import { ProjectCreateSteps } from '../projectCreateSteps';

beforeEach(() => broadcast.mockClear());

describe('ProjectCreateSteps', () => {
  it('broadcasts each change on hermes-projects:create-progress', () => {
    const steps = new ProjectCreateSteps('run-1', ['task']);
    steps.start('task');

    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith('hermes-projects:create-progress', {
      runId: 'run-1',
      steps: [{ id: 'task', status: 'running' }],
    });
  });
});
