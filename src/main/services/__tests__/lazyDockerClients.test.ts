import { afterEach, describe, expect, it, vi } from 'vitest';

describe('lazy dockerode clients', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('does not construct Docker when dockerService is imported', async () => {
    const DockerMock = vi.fn();
    vi.doMock('dockerode', () => ({ default: DockerMock }));
    vi.doMock('../containerRuntime', () => ({
      getContainerRuntime: vi.fn(),
      dockerodeOptionsFromApiEndpoint: vi.fn(),
      runCompose: vi.fn(),
    }));

    await import('../dockerService');

    expect(DockerMock).not.toHaveBeenCalled();
  });

  it('constructs Docker on first isDockerRunning call', async () => {
    const ping = vi.fn().mockResolvedValue({});
    const getEvents = vi.fn().mockResolvedValue({
      on: vi.fn(),
    });
    const DockerMock = vi.fn().mockImplementation(() => ({
      ping,
      getEvents,
      listContainers: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('dockerode', () => ({ default: DockerMock }));
    vi.doMock('../containerRuntime', () => ({
      getContainerRuntime: vi.fn().mockResolvedValue({
        kind: 'docker',
        origin: 'system',
        cliPath: 'docker',
        composeArgv: ['compose'],
        env: process.env,
        apiEndpoint: 'unix:///var/run/docker.sock',
        version: { cli: '27', compose: '2' },
      }),
      dockerodeOptionsFromApiEndpoint: vi.fn().mockReturnValue({
        socketPath: '/var/run/docker.sock',
      }),
      runCompose: vi.fn(),
    }));

    const { dockerService } = await import('../dockerService');
    expect(DockerMock).not.toHaveBeenCalled();

    await dockerService.isDockerRunning();

    expect(DockerMock).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalled();
  });

  it('does not construct Docker when urlDetectionService is imported', async () => {
    const DockerMock = vi.fn();
    vi.doMock('dockerode', () => ({ default: DockerMock }));
    vi.doMock('../containerRuntime', () => ({
      getContainerRuntime: vi.fn(),
      dockerodeOptionsFromApiEndpoint: vi.fn(),
    }));

    await import('../urlDetectionService');

    expect(DockerMock).not.toHaveBeenCalled();
  });
});
