import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostResourceSnapshot } from '../../../../shared/types/hostResources';
import { captureIpcHandlers } from '../../__tests__/captureIpcHandlers';

vi.mock('../../containerRuntime', () => ({
  dockerodeOptionsFromApiEndpoint: vi.fn(),
  getContainerRuntime: vi.fn(),
  runCompose: vi.fn(),
}));
vi.mock('../HostResourceAttribution', () => ({
  createDefaultResourceProbes: vi.fn(() => ({})),
  sampleHostResources: vi.fn(),
}));

let handler: ReturnType<typeof captureIpcHandlers>['handler'];
let listCalls = 0;

function fakeContents(id: number) {
  const sent: unknown[] = [];
  return {
    sent,
    contents: {
      id,
      isDestroyed: () => false,
      send: (_channel: string, snapshot: unknown) => sent.push(snapshot),
      once: vi.fn(),
      off: vi.fn(),
    },
  };
}

/** Runs the fake clock forward, settling every read the handlers started meanwhile. */
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeAll(async () => {
  ({ handler } = captureIpcHandlers());
  const { dockerService } = await import('../../dockerService');
  // An already-connected client, so ensureReady starts no event stream or interval.
  Object.assign(dockerService as unknown as Record<string, unknown>, {
    docker: {
      ping: vi.fn(async () => 'OK'),
      listContainers: vi.fn(async () => {
        listCalls++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return [];
      }),
    },
    isConnected: true,
  });
  const { registerResourceHandlers } = await import('../ipcHandlers');
  registerResourceHandlers();
});

describe('compose inventory subscription', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the inventory once per subscribe and once per engine update', async () => {
    const { dockerService } = await import('../../dockerService');
    const { contents, sent } = fakeContents(1);
    listCalls = 0;

    await handler('resources:subscribe-compose-inventory')({ sender: contents });
    await wait(300);
    expect(listCalls).toBe(1);
    expect(sent).toHaveLength(1);

    dockerService.emit('compose-configs-updated', []);
    await wait(300);
    expect(listCalls).toBe(2);
    expect(sent).toHaveLength(2);

    await handler('resources:unsubscribe-compose-inventory')({ sender: contents });
  });

  it('does not start a read loop from get-compose-inventory', async () => {
    const { contents } = fakeContents(2);
    await handler('resources:subscribe-compose-inventory')({ sender: contents });
    await wait(50);
    listCalls = 0;

    const read = handler('resources:get-compose-inventory')({ sender: contents });
    await wait(300);
    await read;
    expect(listCalls).toBe(1);

    await handler('resources:unsubscribe-compose-inventory')({ sender: contents });
  });
});

describe('resources:get-snapshot', () => {
  it('shares one in-flight sample between overlapping requests', async () => {
    const { sampleHostResources } = await import('../HostResourceAttribution');
    const snapshot = { collectedAt: 'now' } as HostResourceSnapshot;
    let finish: () => void = () => {};
    vi.mocked(sampleHostResources).mockReset();
    vi.mocked(sampleHostResources).mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve(snapshot)))
    );
    const getSnapshot = handler('resources:get-snapshot');

    const first = getSnapshot({});
    const second = getSnapshot({});
    expect(sampleHostResources).toHaveBeenCalledTimes(1);
    finish();
    await expect(first).resolves.toBe(snapshot);
    await expect(second).resolves.toBe(snapshot);

    const third = getSnapshot({});
    expect(sampleHostResources).toHaveBeenCalledTimes(2);
    finish();
    await expect(third).resolves.toBe(snapshot);
  });
});
