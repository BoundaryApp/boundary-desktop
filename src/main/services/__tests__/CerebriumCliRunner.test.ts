import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  installManagedCerebrium: vi.fn().mockResolvedValue(undefined),
  canInstallCerebriumAutomatically: vi.fn().mockResolvedValue(true),
  isManagedCerebriumInstalled: vi.fn().mockResolvedValue(true),
  logToTask: vi.fn().mockResolvedValue(undefined),
  spawn: vi.fn(),
}));

vi.mock('../infrastructure/CerebriumInstaller', () => ({
  canInstallCerebriumAutomatically: mocks.canInstallCerebriumAutomatically,
  getManagedCerebriumExecutable: () => '/managed/bin/cerebrium',
  installManagedCerebrium: mocks.installManagedCerebrium,
  isManagedCerebriumInstalled: mocks.isManagedCerebriumInstalled,
}));

vi.mock('../taskService', () => ({
  taskService: {
    logToTask: mocks.logToTask,
  },
}));

vi.mock('child_process', () => ({
  spawn: mocks.spawn,
}));

vi.mock('fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

function mockSpawnResult(code: number, stdout = '', stderr = '') {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => child.emit('close', 1));

  setTimeout(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', code);
  }, 0);

  return child;
}

import { runCerebriumDeploy } from '../infrastructure/CerebriumCliRunner';

describe('CerebriumCliRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.installManagedCerebrium.mockResolvedValue(undefined);
    mocks.canInstallCerebriumAutomatically.mockResolvedValue(true);
    mocks.isManagedCerebriumInstalled.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs managed Cerebrium CLI when PATH resolution fails', async () => {
    mocks.spawn
      // Initial resolution: cerebrium, uvx, managed all fail version/help probes.
      .mockImplementationOnce(() => mockSpawnResult(1))
      .mockImplementationOnce(() => mockSpawnResult(1))
      .mockImplementationOnce(() => mockSpawnResult(1))
      .mockImplementationOnce(() => mockSpawnResult(1))
      .mockImplementationOnce(() => mockSpawnResult(1))
      .mockImplementationOnce(() => mockSpawnResult(1))
      // Post-install resolution: cerebrium and uvx fail, managed version works.
      .mockImplementationOnce(() => mockSpawnResult(1))
      .mockImplementationOnce(() => mockSpawnResult(1))
      .mockImplementationOnce(() => mockSpawnResult(1))
      .mockImplementationOnce(() => mockSpawnResult(1))
      .mockImplementationOnce(() => mockSpawnResult(0, 'cerebrium 1.0.0'))
      // project set and deploy.
      .mockImplementationOnce(() => mockSpawnResult(0))
      .mockImplementationOnce(() => mockSpawnResult(0, 'deployed'));

    const result = await runCerebriumDeploy({
      cwd: '/tmp/cerebrium-project',
      taskId: 'task-1',
      serviceAccountToken: 'service-token',
      projectId: 'p-test',
      hfToken: 'hf-token',
    });

    expect(result.success).toBe(true);
    expect(mocks.installManagedCerebrium).toHaveBeenCalled();
    expect(mocks.logToTask).toHaveBeenCalledWith(
      'task-1',
      'Installing Cerebrium CLI (one-time setup)...',
      'info'
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/managed/bin/cerebrium',
      ['version'],
      expect.objectContaining({})
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/managed/bin/cerebrium',
      ['project', 'set', 'p-test'],
      expect.objectContaining({ cwd: '/tmp/cerebrium-project' })
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/managed/bin/cerebrium',
      ['deploy', '-y'],
      expect.objectContaining({ cwd: '/tmp/cerebrium-project' })
    );
  });
});
