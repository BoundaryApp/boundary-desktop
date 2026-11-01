/**
 * A strict fake of the preload bridge for renderer integration tests: the real chat runtime,
 * thread and app lifecycle mount against it. A test fakes only the leaves its screen calls;
 * any other leaf throws "not faked" and is listed in `unfaked`, so a missing piece is named
 * instead of hanging the way `electronApiFake`'s never-settling defaults do.
 *
 * Leaves are typed from `ElectronAPI`, and event leaves from the IPC channel table, so the
 * fake breaks the type check when the bridge changes shape.
 */
import { act } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import type { ElectronAPI } from '../../preload';
import type {
  IpcArgs,
  IpcChannel,
  IpcEventChannel,
  IpcEventChannels,
  IpcReturn,
} from '../../shared/ipc/channels';
import type {
  HermesChatApprovalEvent,
  HermesChatEndEvent,
  HermesChatMessage,
  HermesChatStartPayload,
  HermesChatStartResult,
  HermesChatToolEvent,
} from '../../shared/types/hermesChat';
import { emptyInferenceProvidersStatus } from '../../shared/types/onboarding';
import { track } from '../product/chat/__tests__/ipcCalls';

export { settle } from '../product/chat/__tests__/ipcCalls';

/** The leaves a test provides, namespace by namespace. */
export type BridgeLeaves = { [N in keyof ElectronAPI]?: Partial<ElectronAPI[N]> };

type Listener = (payload: never) => void;

export interface FakeBridge {
  /** A subscription leaf for `channel`, built the way preload's `listen` builds one. */
  listen<C extends IpcEventChannel>(
    channel: C
  ): (callback: (payload: IpcEventChannels[C]) => void) => () => void;
  /** Sends a main-to-renderer event to every listener on `channel`, inside `act`. */
  emit<C extends IpcEventChannel>(channel: C, payload: IpcEventChannels[C]): Promise<void>;
  /** Leaves the screen called that the test did not fake, as `namespace.leaf`. */
  readonly unfaked: string[];
  /** Puts the fake on `window.electronAPI` with these leaves; every other leaf throws. */
  install(leaves: BridgeLeaves): void;
  /**
   * Main's half, for a test that runs real main code against this bridge: a mock of
   * `electron` routes `ipcMain.handle` and a window's `webContents.send` here.
   */
  readonly main: {
    handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
    send(channel: string, payload: unknown): void;
  };
  /** A leaf that invokes the handler main registered for `channel`. */
  invoke<C extends IpcChannel>(channel: C): (...args: IpcArgs<C>) => Promise<Awaited<IpcReturn<C>>>;
}

export function createFakeBridge(): FakeBridge {
  const listeners = new Map<IpcEventChannel, Set<Listener>>();
  const unfaked: string[] = [];
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const deliver = (channel: string, payload: unknown) => {
    for (const listener of [...(listeners.get(channel as IpcEventChannel) ?? [])]) {
      (listener as (p: unknown) => void)(payload);
    }
  };

  const bridge: FakeBridge = {
    unfaked,
    main: {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
      send: (channel, payload) => act(() => deliver(channel, payload)),
    },
    invoke(channel) {
      return async (...args) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`main registered no handler for ${channel}`);
        return (await handler({}, ...args)) as Awaited<IpcReturn<typeof channel>>;
      };
    },
    listen(channel) {
      return (callback) => {
        const set = listeners.get(channel) ?? new Set<Listener>();
        listeners.set(channel, set);
        const listener = callback as Listener;
        set.add(listener);
        return () => {
          set.delete(listener);
        };
      };
    },
    async emit(channel, payload) {
      await act(async () => deliver(channel, payload));
    },
    install(leaves) {
      const given = leaves as Record<string, Record<string, unknown> | undefined>;
      const namespaces = new Map<string, Record<string, unknown>>();
      const namespace = (name: string) => {
        let ns = namespaces.get(name);
        if (ns) return ns;
        const provided = given[name] ?? {};
        const tracked: Record<string, unknown> = {};
        ns = new Proxy(tracked, {
          get(target, leaf) {
            if (typeof leaf !== 'string' || leaf === 'then') return undefined;
            if (leaf in target) return target[leaf];
            const impl = provided[leaf];
            target[leaf] =
              typeof impl === 'function'
                ? track(impl as (...args: unknown[]) => unknown)
                : impl !== undefined
                  ? impl
                  : (..._args: unknown[]) => {
                      const id = `${name}.${leaf}`;
                      if (!unfaked.includes(id)) unfaked.push(id);
                      throw new Error(`electronAPI.${id} is not faked`);
                    };
            return target[leaf];
          },
        });
        namespaces.set(name, ns);
        return ns;
      };
      const api = new Proxy({} as Record<string, unknown>, {
        get(_target, name) {
          if (typeof name !== 'string' || name === 'then') return undefined;
          return namespace(name);
        },
      });
      Object.defineProperty(window, 'electronAPI', { value: api, configurable: true, writable: true });
    },
  };
  return bridge;
}

// ─── Hermes chat ─────────────────────────────────────────────────────────────

export interface FakeHermesChat {
  /** The chat's stored messages, as `getHistory` returns them. */
  history: HermesChatMessage[];
  /** Merged into the next `startChat` answer only (a room post: `{ posted: true }`). */
  nextStart: Partial<HermesChatStartResult> | null;
  startChat: Mock<(payload: HermesChatStartPayload) => Promise<HermesChatStartResult>>;
  cancelChat: Mock<ElectronAPI['hermesChat']['cancelChat']>;
  respondApproval: Mock<ElectronAPI['hermesChat']['respondApproval']>;
  /** The request id of the latest `startChat`. */
  requestId(): string;
  /** Streams reply text into the latest run. */
  stream(delta: string, agentSlug?: string): Promise<void>;
  tool(event: Omit<HermesChatToolEvent, 'requestId'>): Promise<void>;
  approval(event: Omit<HermesChatApprovalEvent, 'sessionId'> & { sessionId?: string }): Promise<void>;
  finish(event?: Omit<HermesChatEndEvent, 'requestId'>): Promise<void>;
  fail(error: string): Promise<void>;
  /** The `hermesChat` leaves the chat thread calls. */
  leaves: Partial<ElectronAPI['hermesChat']>;
}

/** Main's side of one Hermes chat, `sessionId`, scripted by the test. */
export function fakeHermesChat(bridge: FakeBridge, sessionId: string): FakeHermesChat {
  let active: string | null = null;
  const requestId = () => {
    if (!active) throw new Error('No run has called startChat yet');
    return active;
  };
  const chat: FakeHermesChat = {
    history: [],
    nextStart: null,
    startChat: vi.fn(async (payload: HermesChatStartPayload) => {
      active = payload.requestId;
      const extra = chat.nextStart ?? {};
      chat.nextStart = null;
      return { success: true, requestId: payload.requestId, sessionId, ...extra };
    }),
    cancelChat: vi.fn(async () => ({ success: true })),
    respondApproval: vi.fn(async () => ({ success: true })),
    requestId,
    stream: (delta, agentSlug) =>
      bridge.emit('hermes-chat:chunk', { requestId: requestId(), delta, ...(agentSlug ? { agentSlug } : {}) }),
    tool: (event) => bridge.emit('hermes-chat:tool', { requestId: requestId(), sessionId, ...event }),
    approval: (event) => bridge.emit('hermes-chat:approval', { sessionId, ...event }),
    finish: (event) => bridge.emit('hermes-chat:end', { requestId: requestId(), sessionId, ...event }),
    fail: (error) => bridge.emit('hermes-chat:error', { requestId: requestId(), error }),
    leaves: {},
  };
  chat.leaves = {
    getHistory: async () => ({ success: true, sessionId, messages: chat.history }),
    startChat: (payload) => chat.startChat(payload),
    cancelChat: (payload) => chat.cancelChat(payload),
    respondApproval: (payload) => chat.respondApproval(payload),
    ackApproval: async () => ({ success: true }),
    listPendingApprovals: async () => [],
    listPendingCredentialRequests: async () => [],
    listRunningTurns: async () => [],
    getContextBreakdown: async () => ({ success: true, breakdown: { categories: [] } }),
    getSessionInference: async () => ({ success: true, override: null, resolved: null, marks: [] }),
    onChatChunk: bridge.listen('hermes-chat:chunk'),
    onChatEnd: bridge.listen('hermes-chat:end'),
    onChatError: bridge.listen('hermes-chat:error'),
    onChatTool: bridge.listen('hermes-chat:tool'),
    onChatPhase: bridge.listen('hermes-chat:phase'),
    onChatSpeaker: bridge.listen('hermes-chat:speaker'),
    onChatApproval: bridge.listen('hermes-chat:approval'),
    onChatCredentialRequest: bridge.listen('hermes-chat:credential-request'),
    onChatTurnStats: bridge.listen('hermes-chat:turn-stats'),
    onRunningTurns: bridge.listen('hermes-chat:running'),
  };
  return chat;
}

// ─── The rest of main, idle ──────────────────────────────────────────────────

/**
 * Leaves for the app-wide stores and side panels a chat screen subscribes to, answering as a
 * main with nothing to report: inference configured, no calendars, no kanban tasks, no host
 * approvals, host tools off. Spread a test's own leaves over these.
 */
function idleMain(bridge: FakeBridge): BridgeLeaves {
  return {
    onboarding: {
      getStatus: async () => ({ ...emptyInferenceProvidersStatus(), configured: true }),
      onStatus: bridge.listen('onboarding:status'),
    },
    calendars: {
      list: async () => ({ success: true, accounts: [] }),
      onChanged: bridge.listen('calendars:changed'),
    },
    kanban: {
      onOpenTask: bridge.listen('hermes-kanban:open-task'),
      snapshot: async () => ({ available: false, tasks: [], checkedAt: 0 }),
      onSnapshot: bridge.listen('hermes-kanban:snapshot'),
    },
    hostBridge: {
      onApproval: bridge.listen('host-bridge:approval'),
      onApprovalCleared: bridge.listen('host-bridge:approval-cleared'),
      listPendingApprovals: async () => [],
      getToolsState: async () => 'off' as const,
      reportScreen: async () => undefined,
      onToolsState: bridge.listen('host-bridge:tools-state'),
    },
    codingFolders: {
      onAccessRequest: bridge.listen('coding-folders:access-request'),
    },
  };
}

/** `idleMain`, with each namespace in `leaves` spread over its idle leaves. */
export function withIdleMain(bridge: FakeBridge, leaves: BridgeLeaves): BridgeLeaves {
  const merged: Record<string, object | undefined> = { ...idleMain(bridge) };
  for (const [name, ns] of Object.entries(leaves)) merged[name] = { ...merged[name], ...ns };
  return merged as BridgeLeaves;
}
