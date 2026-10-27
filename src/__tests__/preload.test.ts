import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ElectronAPI } from '../preload';

const h = vi.hoisted(() => ({
  exposed: {} as Record<string, unknown>,
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  invoke: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      h.exposed[key] = value;
    },
  },
  ipcRenderer: {
    invoke: h.invoke,
    send: vi.fn(),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      if (!h.listeners.has(channel)) h.listeners.set(channel, new Set());
      h.listeners.get(channel)!.add(listener);
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
      h.listeners.get(channel)?.delete(listener);
    },
  },
}));

let api: ElectronAPI;

beforeAll(async () => {
  await import('../preload');
  api = h.exposed.electronAPI as ElectronAPI;
});

function listenerCount(): number {
  let count = 0;
  for (const set of h.listeners.values()) count += set.size;
  return count;
}

describe('preload bridge', () => {
  it('passes invoke leaves through to their channel with the arguments given', async () => {
    await api.kanban.taskLog('t1', 400);
    expect(h.invoke).toHaveBeenLastCalledWith('hermes-kanban:task-log', 't1', 400);
    await api.urls.openUrl('https://example.com');
    expect(h.invoke).toHaveBeenLastCalledWith('urls:open-url', 'https://example.com');
  });

  it('returns a remover from every subscription leaf', () => {
    const leaves: Array<[string, (callback: (payload: unknown) => void) => () => void]> = [];
    for (const [namespace, members] of Object.entries(api)) {
      for (const [name, leaf] of Object.entries(members as Record<string, unknown>)) {
        if (/^(on|subscribe)[A-Z]/.test(name)) {
          leaves.push([`${namespace}.${name}`, leaf as (callback: (payload: unknown) => void) => () => void]);
        }
      }
    }
    expect(leaves.length).toBeGreaterThanOrEqual(25);
    for (const [name, leaf] of leaves) {
      const before = listenerCount();
      const remove = leaf(() => undefined);
      expect(listenerCount(), name).toBe(before + 1);
      expect(typeof remove, name).toBe('function');
      remove();
      expect(listenerCount(), name).toBe(before);
    }
  });

  it('delivers the event payload to the callback without the IPC event', () => {
    const callback = vi.fn();
    const remove = api.hermesChat.onChatChunk(callback);
    for (const listener of h.listeners.get('hermes-chat:chunk')!) {
      listener({ sender: null }, { requestId: 'r1' });
    }
    expect(callback).toHaveBeenCalledWith({ requestId: 'r1' });
    remove();
  });

  it('subscribes main to the compose inventory and unsubscribes on remove', () => {
    const remove = api.resources.subscribeComposeInventory(() => undefined);
    expect(h.invoke).toHaveBeenLastCalledWith('resources:subscribe-compose-inventory');
    remove();
    expect(h.invoke).toHaveBeenLastCalledWith('resources:unsubscribe-compose-inventory');
  });
});
