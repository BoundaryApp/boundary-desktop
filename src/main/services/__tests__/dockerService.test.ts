import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../containerRuntime', () => ({
  dockerodeOptionsFromApiEndpoint: vi.fn(),
  getContainerRuntime: vi.fn(),
  runCompose: vi.fn(),
}));

type Internals = {
  docker: unknown;
  isConnected: boolean;
  startEventStream: () => Promise<void>;
};

async function connectedService(client: Record<string, unknown>) {
  vi.resetModules();
  const { dockerService } = await import('../dockerService');
  // An already-connected client, so ensureReady starts no event stream or interval.
  Object.assign(dockerService as unknown as Internals, { docker: client, isConnected: true });
  return dockerService;
}

function composeContainer(workingDir: string, labels: Record<string, string> = {}) {
  return {
    State: 'running',
    Status: 'Up 2 minutes (unhealthy)',
    Image: 'example/web',
    Ports: [],
    Labels: {
      'com.docker.compose.project': 'demo',
      'com.docker.compose.service': 'web',
      'com.docker.compose.project.working_dir': workingDir,
      ...labels,
    },
  };
}

describe('dockerService compose configs', () => {
  it('keeps a project whose directory holds only compose.yaml', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'compose-yaml-'));
    await writeFile(path.join(dir, 'compose.yaml'), 'services: {}\n');
    const service = await connectedService({
      listContainers: vi.fn(async () => [composeContainer(dir)]),
    });

    const configs = await service.getComposeConfigs();
    expect(configs.map((config) => config.path)).toEqual([dir]);
  });

  it('keeps a project started with -f and a custom file name', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'compose-custom-'));
    const file = path.join(dir, 'stack.yml');
    await writeFile(file, 'services: {}\n');
    const service = await connectedService({
      listContainers: vi.fn(async () => [
        composeContainer(dir, { 'com.docker.compose.project.config_files': file }),
      ]),
    });

    const configs = await service.getComposeConfigs();
    expect(configs.map((config) => config.path)).toEqual([dir]);
  });

  it('drops a project whose compose files are gone', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'compose-gone-'));
    const service = await connectedService({
      listContainers: vi.fn(async () => [composeContainer(dir)]),
    });

    expect(await service.getComposeConfigs()).toEqual([]);
  });

  it('classes an (unhealthy) container as unhealthy', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'compose-health-'));
    await writeFile(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
    const service = await connectedService({
      listContainers: vi.fn(async () => [composeContainer(dir)]),
    });

    const [config] = await service.getComposeConfigs();
    expect(config.services[0].health).toBe('unhealthy');
  });
});

describe('dockerService event stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeEvents() {
    const streams: EventEmitter[] = [];
    const getEvents = vi.fn(async () => {
      const stream = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      streams.push(stream);
      return stream;
    });
    return { streams, getEvents };
  }

  it('schedules one reconnect when a stream emits error and then end', async () => {
    const { streams, getEvents } = fakeEvents();
    const service = await connectedService({ getEvents });
    await (service as unknown as Internals).startEventStream();

    streams[0].emit('error', new Error('socket hang up'));
    streams[0].emit('end');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getEvents).toHaveBeenCalledTimes(2);
    service.destroy();
  });

  it('does not reconnect after destroy', async () => {
    const { streams, getEvents } = fakeEvents();
    const service = await connectedService({ getEvents });
    await (service as unknown as Internals).startEventStream();

    streams[0].emit('end');
    service.destroy();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getEvents).toHaveBeenCalledTimes(1);
  });
});

describe('isComposeRelevantEvent', () => {
  it('skips health-check execs and other actions that leave a project unchanged', async () => {
    const { isComposeRelevantEvent } = await import('../dockerService');
    for (const Action of ['exec_create: /bin/sh -c curl -f localhost', 'exec_start: /bin/sh -c true', 'exec_die', 'attach', 'resize', 'top']) {
      expect(isComposeRelevantEvent({ Type: 'container', Action })).toBe(false);
    }
  });

  it('keeps lifecycle and health changes, and only for containers', async () => {
    const { isComposeRelevantEvent } = await import('../dockerService');
    for (const Action of ['create', 'start', 'stop', 'die', 'destroy', 'rename', 'health_status: unhealthy']) {
      expect(isComposeRelevantEvent({ Type: 'container', Action })).toBe(true);
    }
    expect(isComposeRelevantEvent({ Type: 'image', Action: 'pull' })).toBe(false);
    expect(isComposeRelevantEvent({ Type: 'container' })).toBe(true);
  });
});

describe('dockerService event refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type EventInternals = { handleDockerEvent: (event: { Type?: string; Action?: string }) => void };

  async function serviceWithListing() {
    const listContainers = vi.fn(async () => []);
    const service = await connectedService({ listContainers });
    const updates = vi.fn();
    service.on('compose-configs-updated', updates);
    return { service: service as typeof service & EventInternals, listContainers, updates };
  }

  it('does not refresh for health-check exec events', async () => {
    const { service, listContainers } = await serviceWithListing();
    for (let i = 0; i < 300; i++) {
      service.handleDockerEvent({ Type: 'container', Action: 'exec_start: /bin/sh -c true' });
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listContainers).not.toHaveBeenCalled();
    service.destroy();
  });

  it('refreshes once for a burst of lifecycle events, after a short delay', async () => {
    const { service, listContainers, updates } = await serviceWithListing();
    service.handleDockerEvent({ Type: 'container', Action: 'stop' });
    service.handleDockerEvent({ Type: 'container', Action: 'die' });
    service.handleDockerEvent({ Type: 'container', Action: 'start' });
    await vi.advanceTimersByTimeAsync(499);
    expect(listContainers).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(listContainers).toHaveBeenCalledTimes(1);
    expect(updates).toHaveBeenCalledTimes(1);

    service.handleDockerEvent({ Type: 'container', Action: 'start' });
    await vi.advanceTimersByTimeAsync(500);
    expect(listContainers).toHaveBeenCalledTimes(2);
    service.destroy();
  });

  it('drops a pending refresh on destroy', async () => {
    const { service, listContainers } = await serviceWithListing();
    service.handleDockerEvent({ Type: 'container', Action: 'start' });
    service.destroy();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listContainers).not.toHaveBeenCalled();
  });
});

describe('dockerService compose file checks', () => {
  it('checks a working directory once however many of its containers are listed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'compose-shared-'));
    await writeFile(path.join(dir, 'compose.yaml'), 'services: {}\n');
    const fsModule = await import('node:fs');
    const access = vi.spyOn(fsModule.promises, 'access');
    const containers = ['web', 'db', 'worker'].map((service) => ({
      ...composeContainer(dir),
      Labels: { ...composeContainer(dir).Labels, 'com.docker.compose.service': service },
    }));
    const service = await connectedService({ listContainers: vi.fn(async () => containers) });

    const configs = await service.getComposeConfigs();
    expect(configs.map((config) => config.services.length)).toEqual([3]);
    const checkedDirs = new Set(access.mock.calls.map(([file]) => path.dirname(String(file))));
    expect([...checkedDirs]).toEqual([dir]);
    expect(access).toHaveBeenCalledTimes(4);
    access.mockRestore();
  });
});
