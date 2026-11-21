import { vi } from 'vitest';
import type { HostKeyCheck, SshConnection, SshTarget } from '../sshConnection';
import { SshStackHostError, type SshStackHost, type StackStatus } from '../sshStackHost';
import type { SshStackSelectionDeps } from '../stackHostSelection';
import { createFakeStackHost, type FakeStackHost, type FakeStackHostOptions } from '../fakeStackHost';

export type FakeSshStackHost = SshStackHost & {
  files: FakeStackHost['files'];
  calls: FakeStackHost['calls'];
  /** Ends the connection as a dropped network would. */
  drop(): void;
};

/** An SSH host with `FakeStackHost`'s files and commands, and no folder on this computer. */
export function createFakeSshStackHost(options: FakeStackHostOptions = {}, label = 'ana@pc.example.com'): FakeSshStackHost {
  const fake = createFakeStackHost({ ...options, capabilities: { hostFolders: false, hostCallbacks: false, provision: false, engineControl: false } });
  let drop!: () => void;
  const closed = new Promise<void>((resolve) => (drop = resolve));
  const status: StackStatus = { version: 'pin', project: 'assistant', engine: true, services: [] };
  return {
    ...fake,
    kind: 'ssh',
    get localPaths(): never {
      throw new SshStackHostError('not_local', `The agent stack is on ${label}, so it has no folder on this computer.`);
    },
    status: () => status,
    refreshEndpoints: async () => status,
    credentials: async () => ({ dashboardPassword: null, dashboardHandoffSecret: null, apiServerKey: null, llmProxyAdminToken: null }),
    close: vi.fn(async () => drop()),
    closed,
    drop: () => drop(),
  };
}

/**
 * Selection deps whose connection reaches a stack at the pin (`.stack-version` read over a fake
 * SFTP) and whose `createHost` hands out `hosts` in order.
 */
export function fakeSelectionDeps(hosts: SshStackHost[], version = 'v0.3.17'): SshStackSelectionDeps & {
  connects: SshTarget[];
} {
  const connects: SshTarget[] = [];
  const connection = (): SshConnection => ({
    exec: vi.fn(),
    sftp: {
      readdir: async () => ['.stack-version', 'docker-compose.yml'],
      readFile: async () => Buffer.from(`${version}\n`),
    } as unknown as SshConnection['sftp'],
    forwardOut: vi.fn(),
    hostKeyFingerprint: 'SHA256:abc',
    closed: new Promise(() => {}),
    close: vi.fn(),
  });
  return {
    connects,
    connect: async (target: SshTarget, check: HostKeyCheck) => {
      connects.push(target);
      if (!(await check('SHA256:abc'))) throw new Error('Host denied');
      return connection();
    },
    readKeyFile: async () => 'KEY',
    agentSocket: () => '/tmp/agent.sock',
    createHost: async () => {
      const next = hosts.shift();
      if (!next) throw new Error('no more fake hosts');
      return next;
    },
    homeDir: '/home/test',
    version,
  };
}
