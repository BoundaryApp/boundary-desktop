import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { HostResourceSnapshot } from '../../../../shared/types/hostResources';

vi.mock('../../containerRuntime', () => ({
  dockerodeOptionsFromApiEndpoint: vi.fn(),
  getContainerRuntime: vi.fn(),
  runCompose: vi.fn(),
}));
vi.mock('../HostResourceAttribution', () => ({
  createDefaultResourceProbes: vi.fn(() => ({})),
  sampleHostResources: vi.fn(),
}));

type Handler = (event: unknown) => unknown;

const handlers = new Map<string, Handler>();
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  const electron = await import('electron');
  vi.mocked(electron.ipcMain.handle).mockImplementation(((channel: string, fn: Handler) => {
    handlers.set(channel, fn);
  }) as never);
  const { dockerService } = await import('../../dockerService');
  // An already-connected client, so ensureReady starts no event stream or interval.
  Object.assign(dockerService as unknown as Record<string, unknown>, {
    docker: {
      ping: vi.fn(async () => 'OK'),
      listContainers: vi.fn(async () => {
        listCalls++;
        await wait(1);
        return [];
      }),
    },
    isConnected: true,
  });
  const { registerResourceHandlers } = await import('../ipcHandlers');
  registerResourceHandlers();
});

describe('compose inventory subscription', () => {
  it('reads the inventory once per subscribe and once per engine update', async () => {
    const { dockerService } = await import('../../dockerService');
    const { contents, sent } = fakeContents(1);
    listCalls = 0;

    await handlers.get('resources:subscribe-compose-inventory')!({ sender: contents });
    await wait(300);
    expect(listCalls).toBe(1);
    expect(sent).toHaveLength(1);

    dockerService.emit('compose-configs-updated', []);
    await wait(300);
    expect(listCalls).toBe(2);
    expect(sent).toHaveLength(2);

    await handlers.get('resources:unsubscribe-compose-inventory')!({ sender: contents });
  });

  it('does not start a read loop from get-compose-inventory', async () => {
    const { contents } = fakeContents(2);
    await handlers.get('resources:subscribe-compose-inventory')!({ sender: contents });
    await wait(50);
    listCalls = 0;

    await handlers.get('resources:get-compose-inventory')!({ sender: contents });
    await wait(300);
    expect(listCalls).toBe(1);

    await handlers.get('resources:unsubscribe-compose-inventory')!({ sender: contents });
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
    const getSnapshot = handlers.get('resources:get-snapshot')!;

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
