import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Store from 'electron-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ASSISTANT_STACK_PORTS,
  portsForIsolationMode,
} from '../../shared/assistantStackConstants';
import { BUILTIN_AGENT_FALLBACK } from '../../shared/hermesAgentIdentity';
import {
  getStoredAssistantPorts,
  repairStoredAssistantPorts,
  setStoredAssistantPorts,
} from '../services/assistant/AssistantStackStore';
import { hermesAgentsStoreName } from '../services/assistant/assistantStackIdentity';
import { repairApiServerListenPort } from '../migrations/assistantStack';
import {
  claimLegacyHermesAgentsStore,
  claimLegacyStoreForActiveStack,
  dropBuiltinStandingDm,
  dropChatFallbacks,
  type LegacyHermesAgentsStore,
  movePendingChannelMessages,
  movePendingChannelMessagesInEveryStore,
  renameLegacyBuiltin,
} from '../migrations/hermesAgentsStores';
import { type Migration, type MigrationRecord, runMigrations } from '../migrations/runner';

vi.mock('../persistDebugLog', () => ({
  persistDebugLog: vi.fn(),
  serializeError: (error: unknown) => ({ message: String(error) }),
}));

let tmp: string;
const prevRoot = process.env.BOUNDARY_ASSISTANT_ROOT;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-migrations-')));
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.BOUNDARY_ASSISTANT_ROOT;
  else process.env.BOUNDARY_ASSISTANT_ROOT = prevRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function memoryRecord(): MigrationRecord & { ids: string[] } {
  const ids: string[] = [];
  return { ids, has: (id) => ids.includes(id), add: (id) => void ids.push(id) };
}

describe('runMigrations', () => {
  it('runs pending migrations in order, once', () => {
    const calls: string[] = [];
    const migrations: Migration[] = ['a', 'b'].map((id) => ({
      id,
      removeAfter: '0.1.0',
      run: () => void calls.push(id),
    }));
    const record = memoryRecord();
    runMigrations(migrations, record);
    runMigrations(migrations, record);
    expect(calls).toEqual(['a', 'b']);
    expect(record.ids).toEqual(['a', 'b']);
  });

  it('runs one that could not finish again at the next start', () => {
    let ready = false;
    const run = vi.fn(() => ready);
    const record = memoryRecord();
    runMigrations([{ id: 'wait', removeAfter: '0.1.0', run }], record);
    expect(record.ids).toEqual([]);
    ready = true;
    runMigrations([{ id: 'wait', removeAfter: '0.1.0', run }], record);
    expect(record.ids).toEqual(['wait']);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('logs a failure and goes on to the next migration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const record = memoryRecord();
    const after = vi.fn();
    runMigrations(
      [
        { id: 'broken', removeAfter: '0.1.0', run: () => { throw new Error('bad'); } },
        { id: 'after', removeAfter: '0.1.0', run: after },
      ],
      record
    );
    expect(after).toHaveBeenCalled();
    expect(record.ids).toEqual(['after']);
    expect(warn).toHaveBeenCalledWith('[migrations] broken failed', expect.any(Error));
    warn.mockRestore();
  });
});

describe('claimLegacyHermesAgentsStore', () => {
  const local = () => ({ kind: 'local' as const, root: '/dev/assistant' });

  it('moves the pre-split store to the local stack and keeps a backup', () => {
    fs.writeFileSync(path.join(tmp, 'hermes-agents.json'), '{"agents":[1]}');
    expect(claimLegacyHermesAgentsStore(local(), tmp)).toBe(true);
    const target = path.join(tmp, `${hermesAgentsStoreName(local())}.json`);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"agents":[1]}');
    expect(fs.existsSync(path.join(tmp, 'hermes-agents.json'))).toBe(false);
    expect(fs.readFileSync(path.join(tmp, 'hermes-agents.pre-split.json'), 'utf8')).toBe(
      '{"agents":[1]}'
    );
  });

  it('never overwrites a stack store that already exists', () => {
    fs.writeFileSync(path.join(tmp, 'hermes-agents.json'), '{"old":true}');
    const target = path.join(tmp, `${hermesAgentsStoreName(local())}.json`);
    fs.writeFileSync(target, '{"current":true}');
    expect(claimLegacyHermesAgentsStore(local(), tmp)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"current":true}');
    expect(fs.existsSync(path.join(tmp, 'hermes-agents.json'))).toBe(true);
  });

  it('leaves the pre-split store alone for the managed stack', () => {
    fs.writeFileSync(path.join(tmp, 'hermes-agents.json'), '{}');
    const managed = { kind: 'managed' as const, root: '/userData/project' };
    expect(claimLegacyHermesAgentsStore(managed, tmp)).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'hermes-agents.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'hermes-agents-managed.json'))).toBe(false);
  });

  it('does nothing without a pre-split store', () => {
    expect(claimLegacyHermesAgentsStore(local(), tmp)).toBe(false);
  });

  it('stays pending while the pre-split store is unclaimed, and finishes once a local stack claims it', () => {
    fs.writeFileSync(path.join(tmp, 'hermes-agents.json'), '{}');
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    expect(claimLegacyStoreForActiveStack(tmp)).toBe(false);
    expect(movePendingChannelMessagesInEveryStore(tmp)).toBe(false);
    process.env.BOUNDARY_ASSISTANT_ROOT = path.join(tmp, 'local-stack');
    expect(claimLegacyStoreForActiveStack(tmp)).toBe(true);
    expect(movePendingChannelMessagesInEveryStore(tmp)).toBe(true);
  });
});

/** An agent store as an earlier version left it. */
function legacyStore(name: string, data: Record<string, unknown>): LegacyHermesAgentsStore {
  const store = new Store<Record<string, unknown>>({ name });
  for (const [key, value] of Object.entries(data)) store.set(key, value);
  return store as unknown as LegacyHermesAgentsStore;
}

describe('hermes agent store migrations', () => {
  it('turns pending channel lines into posts and keeps existing posts', () => {
    const kept = { id: 'p1', content: 'kept', createdAt: '2026-09-01T00:00:00.000Z', delivery: 'posted' };
    const store = legacyStore('hermes-agents-local-pending', {
      pendingChannelMessages: { room: ['hello', 'again'], posted: ['old'], empty: [] },
      channelPosts: { posted: [kept] },
    });
    movePendingChannelMessages(store);
    expect(store.get('channelPosts')).toEqual({
      room: [
        { id: 'pending:room:0', content: 'hello', createdAt: new Date(0).toISOString(), delivery: 'posted' },
        { id: 'pending:room:1', content: 'again', createdAt: new Date(0).toISOString(), delivery: 'posted' },
      ],
      posted: [kept],
    });
    expect(store.get('pendingChannelMessages')).toBeUndefined();
  });

  it('drops only the matching fallbacks from a chat’s override', () => {
    const gone = { slot: 'peer', modelId: 'm', peer: { circleId: 'old', providerId: 'p' } };
    const local = { slot: 'local' };
    const store = legacyStore('hermes-agents-local-fallbacks', {
      sessionMeta: {
        mixed: { title: 't', inference: { provider: 'local', modelId: 'a', fallbacks: [gone, local] } },
        only: { inference: { provider: 'local', modelId: 'a', fallbacks: [gone] } },
        other: { inference: { provider: 'local', modelId: 'a', fallbacks: [local] } },
      },
    });
    dropChatFallbacks(store, (entry) => entry.peer?.circleId === 'old');
    expect(store.get('sessionMeta')).toEqual({
      mixed: { title: 't', inference: { provider: 'local', modelId: 'a', fallbacks: [local] } },
      only: { inference: { provider: 'local', modelId: 'a' } },
      other: { inference: { provider: 'local', modelId: 'a', fallbacks: [local] } },
    });
  });

  it('changes every per-stack store file once the pre-split store is gone', () => {
    fs.writeFileSync(path.join(tmp, 'hermes-agents-local-everyone.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'hermes-agents.pre-split.json'), '{}');
    const store = legacyStore('hermes-agents-local-everyone', {
      pendingChannelMessages: { room: ['hello'] },
    });
    expect(movePendingChannelMessagesInEveryStore(tmp)).toBe(true);
    expect(store.get('channelPosts')?.room).toHaveLength(1);
  });

  const legacyBuiltin = {
    slug: 'assistant',
    displayName: 'Assistant',
    handle: 'Assistant',
    role: 'Default agent on this machine. Today’s single chat, named.',
    builtIn: true,
    createdAt: '2026-09-21T00:00:00.000Z',
  };
  const ana = {
    slug: 'ana',
    displayName: 'Ana',
    handle: 'Ana',
    role: 'Researcher',
    builtIn: false,
    createdAt: '2026-09-22T00:00:00.000Z',
  };

  it('renames an untouched Assistant record and keeps the slug and other agents', () => {
    const store = legacyStore('hermes-agents-local-rename', { agents: [legacyBuiltin, ana] });
    renameLegacyBuiltin(store);
    expect(store.get('agents')).toEqual([
      { ...BUILTIN_AGENT_FALLBACK, createdAt: legacyBuiltin.createdAt },
      ana,
    ]);
  });

  it('leaves a built-in record that is no longer the legacy default', () => {
    const filled = { ...legacyBuiltin, displayName: 'Atlas', handle: 'Atlas' };
    const store = legacyStore('hermes-agents-local-filled', { agents: [filled] });
    renameLegacyBuiltin(store);
    expect(store.get('agents')).toEqual([filled]);
  });

  it("drops the built-in agent's pre-0023 standing DM and keeps personalities'", () => {
    const store = legacyStore('hermes-agents-local-dm', {
      standingDmByAgent: { assistant: 'old-standing', ana: 'dm-ana' },
    });
    dropBuiltinStandingDm(store);
    expect(store.get('standingDmByAgent')).toEqual({ ana: 'dm-ana' });
  });
});

describe('repairApiServerListenPort', () => {
  const envPath = () => path.join(tmp, 'hermes', 'profiles', 'api-server', '.env');
  const write = (contents: string) => {
    fs.mkdirSync(path.dirname(envPath()), { recursive: true });
    fs.writeFileSync(envPath(), contents);
  };

  it('puts back the container port where an earlier run wrote the host port', () => {
    write('A=1\nAPI_SERVER_PORT=18643\nB=2\n');
    repairApiServerListenPort(tmp);
    expect(fs.readFileSync(envPath(), 'utf8')).toBe('A=1\nAPI_SERVER_PORT=8643\nB=2\n');
  });

  it('adds the port when the file lacks it', () => {
    write('A=1\n\n');
    repairApiServerListenPort(tmp);
    expect(fs.readFileSync(envPath(), 'utf8')).toBe('A=1\nAPI_SERVER_PORT=8643\n');
  });

  it('does nothing without the profile', () => {
    expect(() => repairApiServerListenPort(tmp)).not.toThrow();
    expect(fs.existsSync(envPath())).toBe(false);
  });
});

describe('repairStoredAssistantPorts', () => {
  const raw = () => new Store<Record<string, unknown>>({ name: 'assistant-stack' });

  it('writes back a complete map for a Phase-1 entry with only core ports', () => {
    setStoredAssistantPorts({ ...DEFAULT_ASSISTANT_STACK_PORTS }, 'default-ports');
    raw().set('ports', { gateway: 8642, apiServer: 8643 });
    expect(getStoredAssistantPorts()).toEqual(DEFAULT_ASSISTANT_STACK_PORTS);
    repairStoredAssistantPorts();
    expect(raw().get('ports')).toEqual(DEFAULT_ASSISTANT_STACK_PORTS);
  });

  it('replaces a mixed map in offset mode', () => {
    setStoredAssistantPorts(portsForIsolationMode('offset-ports'), 'offset-ports');
    raw().set('ports', { ...DEFAULT_ASSISTANT_STACK_PORTS, gateway: 18642 });
    expect(getStoredAssistantPorts()).toEqual(portsForIsolationMode('offset-ports'));
    repairStoredAssistantPorts();
    expect(raw().get('ports')).toEqual(portsForIsolationMode('offset-ports'));
  });
});
