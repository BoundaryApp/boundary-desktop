/**
 * Shared fakes for the hermesChatSessions tests, which are split by feature across
 * `hermesChatSessions*.test.ts`. Each file registers the same `vi.mock` calls with the factories
 * below, so every split runs against the same stand-ins:
 *
 * - the gateway session (`fakeGatewaySession`, its handler set read live while emitting),
 * - the agent store, agents, channels and chat-projects modules, reduced to what the turn code
 *   reads,
 * - inference readiness, the WebUI session list, the sessions-changed broadcast and the debug log.
 *
 * Create the fakes once per file with `vi.hoisted`, as `hermesChatSessionsListing.test.ts` does.
 * The modules are imported once per file; `resetModuleMocks` puts the mock factories' `vi.fn`s
 * back to the defaults below before each test, so give each one its default as `vi.fn(impl)`.
 */
import { vi } from 'vitest';
import { fakeGatewaySession } from './fakeGatewaySession';

/**
 * Stopping a turn starts the settle wait's INTERRUPT_SETTLE_MS timer, which outlives the test.
 * On a real clock it would fire into a later test and add a 'turn stop settled' line there;
 * a fake one is discarded by vi.useRealTimers. Any test that stops a turn needs this.
 */
export const FAKE_SETTLE_TIMER = ['setTimeout', 'clearTimeout'] as const;

export function createChatSessionFakes() {
  const gw = fakeGatewaySession(
    {
      listSessions: vi.fn(),
      createSessionWithSeed: vi.fn(),
      resumeSession: vi.fn(),
      getSessionHistory: vi.fn(),
      ensureConnected: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({})),
      applyToolsEnabled: vi.fn(async (..._args: unknown[]): Promise<void> => {}),
      getMaxTurns: vi.fn(async (..._args: unknown[]): Promise<number | null> => null),
      submitPrompt: vi.fn(async (..._args: unknown[]): Promise<{ status: string | null }> => ({ status: 'streaming' })),
      storedSessionId: vi.fn((id: string) => id),
      cancelPrompt: vi.fn(async (..._args: unknown[]): Promise<void> => {}),
      getLiveStatus: vi.fn(),
      getTurnLiveness: vi.fn(),
      setApprovalNotifier: vi.fn(),
      setCredentialRequestNotifier: vi.fn(),
      setStoredIdArchive: vi.fn(),
    },
    { liveHandlers: true }
  );
  // Debug-log lines, so tests can check what a turn writes (ADR 0031 §6).
  const persistDebugLog = vi.fn();
  return {
    ...gw.fns,
    gw,
    /** Gateway events, so a test can finish a turn by emitting message.complete. */
    emitGateway: gw.emit,
    /** What `getLastAppliedLlm` answers. */
    state: { lastApplied: null as { slot: string; routed?: boolean } | null },
    historyBudgetFor: vi.fn((_id: string): number | undefined => undefined),
    resolveProfileForAgent: vi.fn((_slug: string | null | undefined): string | null => null),
    listWebuiSessions: vi.fn(),
    getWebuiSessionHistory: vi.fn(),
    readAgentSoul: vi.fn((_slug: string): string | null => null),
    roomSoulsSent: new Map<string, string>(),
    getOrchestratorRecord: vi.fn((): { slug: string; kanbanEnabled: boolean } | null => null),
    persistDebugLog,
    turnLines: () =>
      persistDebugLog.mock.calls
        .filter(([area]) => area === 'chat-turn')
        .map(([, message, data]) => ({ message: message as string, ...(data as Record<string, unknown>) })),
    ensureResolvedInferenceReady: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
      ok: true,
      resolved: {
        slot: 'local',
        modelId: 'qwen3:14b',
        providerDisplayName: 'Local',
        provenance: 'app-default',
        configured: true,
        needsRestart: false,
      },
    })),
    setSessionInferenceOverride: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ success: true })),
    broadcastSessionsChanged: vi.fn(),
  };
}

/**
 * Resets every `vi.fn` exported by the given mocked modules to the implementation it was made
 * with, the state a fresh run of the mock factory would give.
 */
export function resetModuleMocks(...modules: object[]): void {
  for (const mod of modules) {
    for (const value of Object.values(mod)) if (vi.isMockFunction(value)) value.mockReset();
  }
}

export type ChatSessionFakes = ReturnType<typeof createChatSessionFakes>;

/**
 * Puts the file's fakes back as `createChatSessionFakes` made them: every `vi.fn` to its
 * default, no last-applied model, no room souls sent. An answer one test sets on, say,
 * `resumeSession` would otherwise reach the next test. Gateway handlers stay: the module under
 * test registers them once, when it is imported.
 */
export function resetChatSessionFakes(f: ChatSessionFakes): void {
  resetModuleMocks(f);
  f.state.lastApplied = null;
  f.roomSoulsSent.clear();
}

export function assistantStackStoreMock(
  actual: typeof import('../../AssistantStackStore'),
  f: ChatSessionFakes
) {
  return { ...actual, getLastAppliedLlm: () => f.state.lastApplied };
}

export function gatewaySessionMock(f: ChatSessionFakes) {
  return { BOUNDARY_SESSION_SOURCE: 'boundary', getHermesGatewaySession: () => f.gw.session };
}

export function persistDebugLogMock(f: ChatSessionFakes) {
  return { persistDebugLog: (...args: unknown[]) => f.persistDebugLog(...args) };
}

export function webuiSyncMock() {
  return { ensureHermesWebuiSyncToInsights: vi.fn() };
}

export function agentStoreMock(f: ChatSessionFakes) {
  return {
    getOrchestratorRecord: () => f.getOrchestratorRecord(),
    getRoomSoulSent: (room: string, slug: string) => f.roomSoulsSent.get(`${room}/${slug}`) ?? null,
    setRoomSoulSent: (room: string, slug: string, hash: string) =>
      f.roomSoulsSent.set(`${room}/${slug}`, hash),
    getSessionAgentSlug: vi.fn(() => null),
    setSessionAgentSlug: vi.fn(),
    getSessionWritingVoice: vi.fn((): string | null => null),
    moveSessionWritingVoice: vi.fn(),
    setRoomVoiceSent: vi.fn(),
    setReplyWritingVoice: vi.fn(),
    getReplyWritingVoices: vi.fn(() => ({})),
    getPromptWritingVoice: vi.fn((): string | null => null),
    setPromptWritingVoice: vi.fn(),
    getSessionChannelId: vi.fn(() => null),
    setSessionChannelId: vi.fn(),
    setStandingDmSessionId: vi.fn(),
    getStoredSessionAlias: vi.fn(() => null),
    setStoredSessionAlias: vi.fn(),
    getStandingDmMap: vi.fn(() => ({ assistant: null })),
    getStandingDmSessionId: vi.fn(() => null),
    listStoredAgents: vi.fn(() => []),
    upsertStoredAgent: vi.fn(),
    getChannelBySessionId: vi.fn(() => null),
    getStoredChannel: vi.fn(() => null),
    getStoredAgent: vi.fn(() => null),
    listStoredChannels: vi.fn(() => []),
    upsertStoredChannel: vi.fn(),
    appendChannelPost: vi.fn((_sessionId: string, input: { content: string; delivery: string }) => ({
      id: 'post-1',
      content: input.content,
      createdAt: '2026-01-01T00:00:00.000Z',
      delivery: input.delivery,
    })),
    appendSessionSpeaker: vi.fn(),
    consumeUnconsumedPosted: vi.fn(() => []),
    listChannelPosts: vi.fn(() => []),
    migrateChannelPosts: vi.fn(),
    migrateSessionInference: vi.fn(),
    getSessionProjectId: vi.fn(() => 'proj-1'),
    copySessionInference: vi.fn(),
    getSessionBranch: vi.fn(() => null),
    setSessionBranch: vi.fn(),
    setChannelPostAssistantCount: vi.fn(),
    getSessionSpeakers: vi.fn(() => []),
    getReplyEndings: vi.fn(() => ({})),
    setReplyEnding: vi.fn(),
    getNoReplies: vi.fn(() => ({})),
    setNoReply: vi.fn(),
    addFailedTurn: vi.fn(),
    deleteFailedChat: vi.fn(),
    getFailedChat: vi.fn(() => null),
    listFailedChats: vi.fn(() => ({})),
    replaceFailedTurn: vi.fn(() => false),
  };
}

/** ADR 0024 filing has its own tests (hermesChatProjects.test.ts). */
export function chatProjectsMock() {
  return {
    fileThreads: (threads: unknown[]) => threads,
    conversationProjectId: vi.fn(() => null),
    setConversationProjectId: vi.fn(),
    applyConversationFolder: vi.fn(async () => undefined),
  };
}

export function agentsMock(f: ChatSessionFakes) {
  return {
    readAgentSoul: (slug: string) => f.readAgentSoul(slug),
    annotateThreadsWithAgents: (threads: unknown[]) => threads,
    resolveProfileForAgent: (slug: string | null | undefined) => f.resolveProfileForAgent(slug),
    durableSessionId: (id: string) => f.storedSessionId(id),
    conversationKindFor: (_id: string, slug: string) => (slug === 'assistant' ? 'hermes' : 'side'),
    DM_HISTORY_BUDGET: 8000,
    historyBudgetFor: (id: string) => f.historyBudgetFor(id),
  };
}

export function channelsMock(
  actual: typeof import('../hermesChannels'),
  store: typeof import('../hermesAgentStore')
) {
  return {
    buildChannelHeader: actual.buildChannelHeader,
    buildMemberSoulContext: actual.buildMemberSoulContext,
    buildOrchestratorRoomNote: actual.buildOrchestratorRoomNote,
    buildChannelWakePrompt: actual.buildChannelWakePrompt,
    channelForSession: (id: string | null | undefined) => {
      if (!id) return null;
      const linked = store.getSessionChannelId(id);
      return store.getChannelBySessionId(id) ?? (linked ? store.getStoredChannel(linked) : null);
    },
    moveChannelSession: vi.fn((channel: { sessionId: string }, id: string) => ({ ...channel, sessionId: id })),
    reconcileChannelSessions: vi.fn(() => 0),
    mergeChannelTranscript: (
      posts: Array<{ content: string; delivery?: string }>,
      messages: Array<{ role: string }>
    ) => {
      if (posts.length === 0) return messages;
      return [
        ...posts.map((p) => ({
          role: 'user',
          content: p.content,
          delivery: p.delivery,
        })),
        ...messages.filter((m) => m.role !== 'user'),
      ];
    },
  };
}

export function sessionInferenceMock(f: ChatSessionFakes) {
  return {
    ensureResolvedInferenceReady: (...args: unknown[]) => f.ensureResolvedInferenceReady(...args),
    setSessionInferenceOverride: (...args: unknown[]) => f.setSessionInferenceOverride(...args),
    noteFallbackServed: vi.fn(async () => undefined),
    noteTurnStarted: vi.fn(),
    noteTurnEnded: vi.fn(),
  };
}

export function webuiSessionsMock(actual: typeof import('../hermesWebuiSessions'), f: ChatSessionFakes) {
  return {
    ...actual,
    listWebuiSessions: (...args: unknown[]) => f.listWebuiSessions(...args),
    getWebuiSessionHistory: (...args: unknown[]) => f.getWebuiSessionHistory(...args),
  };
}

export function sessionsChangedMock(actual: typeof import('../hermesSessionsChanged'), f: ChatSessionFakes) {
  return { ...actual, broadcastSessionsChanged: () => f.broadcastSessionsChanged(), broadcastInferenceNoted: vi.fn() };
}
