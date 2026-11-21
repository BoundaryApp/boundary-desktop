import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshStackSelection } from '../../stackHost/stackHostSelection';

const fakes = await vi.hoisted(async () => (await import('./stackServiceMocks')).createComposeFakes());
const state = vi.hoisted(() => ({
  location: undefined as unknown,
  selection: null as SshStackSelection | null,
}));

vi.mock('../../containerRuntime', async (importOriginal) =>
  (await import('./stackServiceMocks')).containerRuntimeMock(await importOriginal(), fakes)
);

vi.mock('../AssistantStackStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../AssistantStackStore')>()),
  getStoredStackHostLocation: () => state.location,
}));

// The SSH connection itself is covered by stackHostSelection.test.ts and test:sshd.
vi.mock('../../stackHost/stackHostSelection', () => ({
  connectSshStackLocation: async () => state.selection,
}));

vi.mock('../provisionSovereignStack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../provisionSovereignStack')>()),
  ensureSovereignProjectProvisioned: vi.fn(async () => {
    throw new Error('provisioned a remote stack');
  }),
}));

import {
  ensureAssistantStackRunning,
  getAssistantStackAccess,
  getLocalStackPaths,
} from '../AssistantStackService';
import { closeStackHost } from '../../stackHost/activeStack';
import { SshStackHostError } from '../../stackHost/sshStackHost';
import { createFakeSshStackHost, type FakeSshStackHost } from '../../stackHost/__tests__/fakeSshStackHost';

const SSH_LOCATION = {
  kind: 'ssh',
  host: 'pc.example.com',
  user: 'ana',
  key: { kind: 'agent' },
  stackFolder: '/srv/stack',
  hostKeyFingerprint: 'SHA256:abc',
};

describe('a stack on another computer', () => {
  let host: FakeSshStackHost;
  const fetchMock = vi.fn(async (_url: string) => ({ ok: true }));

  beforeEach(() => {
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', undefined);
    state.location = SSH_LOCATION;
    host = createFakeSshStackHost({ ports: { apiServer: 50123 } });
    state.selection = { ok: true, host };
    fakes.runCompose.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  });

  afterEach(async () => {
    await closeStackHost();
    vi.unstubAllGlobals();
  });

  it('attaches on start through the SSH host, without provisioning or local compose', async () => {
    const result = await ensureAssistantStackRunning();
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:50123/health', expect.anything());
    expect(fakes.runCompose).not.toHaveBeenCalled();
  });

  it('runs stack access through the SSH host, and has no folder on this computer', async () => {
    await ensureAssistantStackRunning();
    await getAssistantStackAccess().compose(['ps'], {});
    expect(host.calls).toContainEqual({ method: 'compose', args: ['ps'] });
    expect(fakes.runCompose).not.toHaveBeenCalled();
    let thrown: unknown;
    try {
      getLocalStackPaths();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SshStackHostError);
    expect((thrown as SshStackHostError).code).toBe('not_local');
  });

  it('reports a stack that needs an upgrade on the start-up screen, without installing it', async () => {
    state.selection = {
      ok: false,
      reason: 'needs_upgrade',
      message: 'The agent stack at ana@pc.example.com:/srv/stack is v0.3.15, but this Boundary needs v0.3.17. Upgrade it.',
      found: 'v0.3.15',
    };
    const result = await ensureAssistantStackRunning();
    expect(result).toMatchObject({ success: false, error: state.selection.message });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
