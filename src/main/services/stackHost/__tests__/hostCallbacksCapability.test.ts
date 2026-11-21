import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STACK_CAPABILITY_MISSING_TEXT } from '../../../../shared/stackCapabilities';
import { createFakeStackHost, type FakeStackHost } from '../fakeStackHost';

// Features whose containers call a listener on this machine, on a host without hostCallbacks.

const h = vi.hoisted(() => ({
  host: null as unknown as FakeStackHost,
  fork: vi.fn(),
  startChainRouter: vi.fn(),
  createUsedServices: vi.fn(),
}));

vi.mock('../capabilities', async () =>
  (await import('../fakeStackHost')).fakeCapabilitiesModule(() => h.host.capabilities)
);
vi.mock('../../../persistDebugLog', () => ({ persistDebugLog: vi.fn() }));
vi.mock('electron', async () => {
  const os = await import('node:os');
  return {
    app: { getPath: () => os.tmpdir(), getName: () => 'Boundary' },
    safeStorage: { isAsyncEncryptionAvailable: async () => false },
    utilityProcess: { fork: h.fork },
    BrowserWindow: { getAllWindows: (): unknown[] => [] },
    Notification: class {
      static isSupported(): boolean {
        return false;
      }
    },
    clipboard: {},
    dialog: {},
    shell: {},
  };
});
vi.mock('../../inference/router/chainRouter', () => ({ startChainRouter: h.startChainRouter }));
vi.mock('../../circles/usedServices', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createUsedServices: h.createUsedServices,
}));

import { ensureHostBridgeStarted } from '../../hostBridge/hostBridgeService';
import { ensureInferenceRouterForStack } from '../../inference/inferenceRouterService';
import { connectMacCalendars } from '../../assistant/calendar/macCalendarAccount';
import { grantMac } from '../../assistant/calendar/macCalendarTokens';
import { useService } from '../../circles/servicesView';
import { startUsedServices } from '../../circles/usedServicesRuntime';
import { configureCircleSharing } from '../../circleSharing/circleSharing';

const refusal = STACK_CAPABILITY_MISSING_TEXT.hostCallbacks;

describe('features that need hostCallbacks, on a host without it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.host = createFakeStackHost({ capabilities: { hostCallbacks: false } });
    // Circles asks the stack host through Boundary's sharing pieces, as the app wires them.
    configureCircleSharing();
  });

  it('the host bridge does not start', async () => {
    await expect(ensureHostBridgeStarted()).rejects.toThrow(refusal);
    expect(h.fork).not.toHaveBeenCalled();
  });

  it('the stack gets no inference router', async () => {
    await expect(ensureInferenceRouterForStack()).resolves.toBeNull();
    expect(h.startChainRouter).not.toHaveBeenCalled();
  });

  it('Mac calendars refuse to connect or grant access', async () => {
    await expect(
      connectMacCalendars({ allowedCalendarIds: ['work'], access: { assistant: 'read' } })
    ).resolves.toMatchObject({ success: false, error: refusal });
    await expect(grantMac('assistant', 'read')).rejects.toThrow(refusal);
  });

  it('services used from a Circle neither start nor accept a new one', async () => {
    await startUsedServices();
    expect(h.createUsedServices).not.toHaveBeenCalled();
    await expect(
      useService({ circle: 'c', provider: 'p', service: 'twenty', access: 'read' as never })
    ).rejects.toThrow(refusal);
  });
});
