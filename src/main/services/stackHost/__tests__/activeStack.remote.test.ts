import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STACK_CAPABILITY_MISSING_TEXT } from '../../../../shared/stackCapabilities';

const stored = vi.hoisted(() => ({ location: undefined as unknown }));

vi.mock('../../assistant/AssistantStackStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../assistant/AssistantStackStore')>()),
  getStoredStackHostLocation: () => stored.location,
}));

import {
  StackHostNotConnected,
  closeStackHost,
  connectedSshStackHost,
  getStackEndpoints,
  getStackFiles,
  selectStackHost,
} from '../activeStack';
import { getStackCapabilities, stackCapabilityRefusal } from '../capabilities';
import { createFakeSshStackHost, fakeSelectionDeps } from './fakeSshStackHost';

const ssh = (host = 'pc.example.com') => ({
  kind: 'ssh',
  host,
  user: 'ana',
  key: { kind: 'agent' },
  stackFolder: '/srv/stack',
  hostKeyFingerprint: 'SHA256:abc',
});

describe('the active stack host', () => {
  beforeEach(() => {
    stored.location = undefined;
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', undefined);
  });

  afterEach(async () => {
    await closeStackHost();
  });

  it('is this computer with every capability when nothing is stored', async () => {
    expect(await selectStackHost(fakeSelectionDeps([]))).toEqual({ kind: 'local' });
    expect(connectedSshStackHost()).toBeNull();
    expect(getStackCapabilities()).toEqual({ hostFolders: true, hostCallbacks: true, provision: true, engineControl: true });
  });

  it('has none of the four capabilities on an SSH location, connected or not', () => {
    stored.location = ssh();
    expect(getStackCapabilities()).toEqual({ hostFolders: false, hostCallbacks: false, provision: false, engineControl: false });
    expect(stackCapabilityRefusal('hostFolders')).toBe(STACK_CAPABILITY_MISSING_TEXT.hostFolders);
    expect(stackCapabilityRefusal('provision')).toBe(STACK_CAPABILITY_MISSING_TEXT.provision);
  });

  it('refuses files and endpoints until the SSH host is open, instead of using this computer', async () => {
    stored.location = ssh();
    expect(() => connectedSshStackHost()).toThrow(StackHostNotConnected);
    expect(() => getStackEndpoints().url('apiServer', '/health')).toThrow(StackHostNotConnected);
    await expect(getStackFiles().readText('stack', '.env')).rejects.toBeInstanceOf(StackHostNotConnected);
  });

  it('sends files and endpoints to the open SSH host, and keeps it', async () => {
    stored.location = ssh();
    const host = createFakeSshStackHost({ files: { 'stack:.env': 'A=1\n' }, ports: { apiServer: 50123 } });
    const deps = fakeSelectionDeps([host]);
    expect(await selectStackHost(deps)).toEqual({ kind: 'ssh', host });
    expect(connectedSshStackHost()).toBe(host);
    expect(await getStackFiles().readText('stack', '.env')).toBe('A=1\n');
    expect(getStackEndpoints().url('apiServer', '/health')).toBe('http://127.0.0.1:50123/health');
    expect(await selectStackHost(deps)).toEqual({ kind: 'ssh', host });
    expect(deps.connects).toHaveLength(1);
  });

  it('shares one connection attempt between callers', async () => {
    stored.location = ssh();
    const host = createFakeSshStackHost();
    const deps = fakeSelectionDeps([host]);
    const [a, b] = await Promise.all([selectStackHost(deps), selectStackHost(deps)]);
    expect(a).toEqual({ kind: 'ssh', host });
    expect(b).toEqual({ kind: 'ssh', host });
    expect(deps.connects).toHaveLength(1);
  });

  it('forgets a host whose connection dropped, and connects again on the next select', async () => {
    stored.location = ssh();
    const first = createFakeSshStackHost();
    const second = createFakeSshStackHost();
    const deps = fakeSelectionDeps([first, second]);
    await selectStackHost(deps);
    first.drop();
    await Promise.resolve();
    await Promise.resolve();
    expect(() => connectedSshStackHost()).toThrow(StackHostNotConnected);
    expect(await selectStackHost(deps)).toEqual({ kind: 'ssh', host: second });
  });

  it('closes the host when the location moves to another computer or back to this one', async () => {
    stored.location = ssh();
    const first = createFakeSshStackHost();
    const second = createFakeSshStackHost();
    const deps = fakeSelectionDeps([first, second]);
    await selectStackHost(deps);
    stored.location = ssh('other.example.com');
    expect(await selectStackHost(deps)).toEqual({ kind: 'ssh', host: second });
    expect(first.close).toHaveBeenCalled();
    expect(deps.connects.map((t) => t.host)).toEqual(['pc.example.com', 'other.example.com']);
    stored.location = undefined;
    expect(await selectStackHost(deps)).toEqual({ kind: 'local' });
    expect(second.close).toHaveBeenCalled();
  });

  it('reports a stack that needs an upgrade without opening a host', async () => {
    stored.location = ssh();
    const deps = fakeSelectionDeps([createFakeSshStackHost()], 'v0.3.17');
    deps.version = 'v0.3.18';
    const result = await selectStackHost(deps);
    expect(result).toMatchObject({ kind: 'error', selection: { reason: 'needs_upgrade', found: 'v0.3.17' } });
    expect(() => connectedSshStackHost()).toThrow(StackHostNotConnected);
  });

  it('reports a malformed stored location instead of using this computer', async () => {
    stored.location = { kind: 'ssh', host: 'pc.example.com' };
    expect(await selectStackHost(fakeSelectionDeps([]))).toEqual({
      kind: 'error',
      message: 'The stored stack location has no user.',
    });
    expect(getStackCapabilities().provision).toBe(false);
  });
});
