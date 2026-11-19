/**
 * Branching, creating and claiming chats.
 * The fakes and mock factories every hermesChatSessions*.test.ts file shares are in
 * hermesChatSessionsFixture.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../hermesAgentStore';
import * as channels from '../hermesChannels';
import * as chatProjects from '../hermesChatProjects';
import * as sessionInference from '../sessionInference';
import * as webuiSync from '../hermesWebuiSync';
import {
  branchHermesChat,
  claimNewSession,
  createHermesChat,
  getHermesChatHistory,
  openAgentDm,
  resetHermesChatSessionsForTests,
} from '../hermesChatSessions';
import { resetRunningTurnsForTests } from '../hermesRunningTurns';
import { resetReplyEndingsForTests } from '../hermesReplyEndings';
import { resetChatSessionFakes, resetModuleMocks } from './hermesChatSessionsFixture';

const f = await vi.hoisted(async () => (await import('./hermesChatSessionsFixture')).createChatSessionFakes());

vi.mock('../../AssistantStackStore', async (importOriginal) =>
  (await import('./hermesChatSessionsFixture')).assistantStackStoreMock(await importOriginal(), f)
);
vi.mock('../hermesGatewaySession', async () => (await import('./hermesChatSessionsFixture')).gatewaySessionMock(f));
vi.mock('../../../../persistDebugLog', async () => (await import('./hermesChatSessionsFixture')).persistDebugLogMock(f));
vi.mock('../hermesWebuiSync', async () => (await import('./hermesChatSessionsFixture')).webuiSyncMock());
vi.mock('../hermesAgentStore', async () => (await import('./hermesChatSessionsFixture')).agentStoreMock(f));
vi.mock('../hermesChatProjects', async () => (await import('./hermesChatSessionsFixture')).chatProjectsMock());
vi.mock('../hermesAgents', async () => (await import('./hermesChatSessionsFixture')).agentsMock(f));
vi.mock('../hermesChannels', async (importOriginal) =>
  (await import('./hermesChatSessionsFixture')).channelsMock(await importOriginal(), await import('../hermesAgentStore'))
);
vi.mock('../sessionInference', async () => (await import('./hermesChatSessionsFixture')).sessionInferenceMock(f));
vi.mock('../hermesWebuiSessions', async (importOriginal) =>
  (await import('./hermesChatSessionsFixture')).webuiSessionsMock(await importOriginal(), f)
);
vi.mock('../hermesSessionsChanged', async (importOriginal) =>
  (await import('./hermesChatSessionsFixture')).sessionsChangedMock(await importOriginal(), f)
);

const {
  listSessions,
  createSessionWithSeed,
  resumeSession,
  resolveProfileForAgent,
  listWebuiSessions,
  storedSessionId,
} = f;

// The modules load once per file; this puts their state back as a fresh import would.
beforeEach(() => {
  resetHermesChatSessionsForTests();
  resetRunningTurnsForTests();
  resetReplyEndingsForTests();
  resetModuleMocks(store, channels, chatProjects, sessionInference, webuiSync);
  resetChatSessionFakes(f);
});

describe('branchHermesChat', () => {
  const seed = [
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'reply' },
    { role: 'assistant' as const, content: '   ' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    createSessionWithSeed.mockResolvedValue('branch-runtime');
    // Boundary holds runtime ids; lineage and navigation must use stored ones.
    const stored: Record<string, string> = {
      'parent-1': 'parent-stored',
      'branch-runtime': 'branch-1',
    };
    storedSessionId.mockImplementation((id: string) => stored[id] ?? id);
    vi.mocked(store.getSessionAgentSlug).mockReturnValue('researcher');
  });

  it('seeds a new chat, links it to the parent and keeps the agent and override', async () => {

    const result = await branchHermesChat({
      parentSessionId: 'parent-1',
      parentTitle: 'Draft outreach',
      seed,
    });

    expect(createSessionWithSeed).toHaveBeenCalledWith({
      title: 'Draft outreach · branch',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ],
      profile: null,
      parentSessionId: 'parent-stored',
    });
    for (const id of ['branch-1', 'branch-runtime']) {
      expect(store.setSessionAgentSlug).toHaveBeenCalledWith(id, 'researcher');
      expect(store.copySessionInference).toHaveBeenCalledWith('parent-1', id);
      expect(store.setSessionBranch).toHaveBeenCalledWith(
        id,
        expect.objectContaining({
          parentId: 'parent-stored',
          parentTitle: 'Draft outreach',
          seededCount: 2,
        })
      );
    }
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
    expect(result.thread).toMatchObject({
      id: 'branch-1',
      title: 'Draft outreach · branch',
      kind: 'side',
      agentSlug: 'researcher',
      branch: { parentId: 'parent-stored', seededCount: 2 },
    });
  });

  it('refuses an empty seed without creating a session', async () => {
    const result = await branchHermesChat({ parentSessionId: 'parent-1', seed: [] });
    expect(result.success).toBe(false);
    expect(createSessionWithSeed).not.toHaveBeenCalled();
  });

  it('reports a gateway failure', async () => {
    createSessionWithSeed.mockRejectedValueOnce(new Error('gateway down'));
    const result = await branchHermesChat({ parentSessionId: 'parent-1', seed });
    expect(result).toEqual({ success: false, error: 'gateway down' });
  });

  it('returns the branch record with history', async () => {
    const branch = { parentId: 'parent-1', seededCount: 2, branchedAt: '2026-09-30T10:00:00.000Z' };
    vi.mocked(store.getSessionBranch).mockReturnValue(branch);
    resumeSession.mockResolvedValue({
      sessionId: 'branch-1',
      messages: [{ role: 'user', content: 'first' }],
    });
    const result = await getHermesChatHistory('branch-1');
    expect(result.branch).toEqual(branch);
  });
});

describe('createHermesChat and openAgentDm (ADR 0023)', () => {
  const ana = {
    slug: 'ana',
    displayName: 'Ana',
    handle: 'Ana',
    role: 'Researcher',
    builtIn: false,
    createdAt: '2026-09-22T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storedSessionId.mockImplementation((id: string) =>
      id.startsWith('runtime-') ? id.replace('runtime-', 'stored-') : id
    );
    vi.mocked(store.getStandingDmSessionId).mockReturnValue(null);
    vi.mocked(store.getStoredAgent).mockImplementation((slug: string) =>
      slug === 'ana' ? ana : null
    );
    resolveProfileForAgent.mockImplementation((slug) =>
      slug && slug !== 'assistant' ? slug : null
    );
  });

  afterEach(() => {
    resolveProfileForAgent.mockImplementation(() => null);
  });

  it('creates a Hermes chat by its stored id without touching any DM', async () => {
    createSessionWithSeed.mockResolvedValue('runtime-h1');
    const result = await createHermesChat();
    expect(createSessionWithSeed).toHaveBeenCalledWith({ profile: null });
    expect(result.thread).toMatchObject({ id: 'stored-h1', kind: 'hermes', agentSlug: 'assistant' });
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
  });

  it("returns a personality's standing DM every time without creating one", async () => {
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-ana');
    const first = await openAgentDm({ agentSlug: 'ana' });
    const second = await openAgentDm({ agentSlug: 'ana' });
    expect(first).toMatchObject({ success: true, created: false, thread: { id: 'dm-ana', kind: 'dm' } });
    expect(second.thread?.id).toBe('dm-ana');
    expect(createSessionWithSeed).not.toHaveBeenCalled();
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
  });

  it('gives an agent without a DM a placeholder, making no session until the first send', async () => {
    const result = await openAgentDm({ agentSlug: 'ana' });
    expect(result).toMatchObject({ success: true, created: true, thread: { kind: 'dm' } });
    const id = result.thread!.id;
    expect(store.setStandingDmSessionId).toHaveBeenCalledWith('ana', id);
    expect(store.setSessionAgentSlug).toHaveBeenCalledWith(id, 'ana');
    expect(createSessionWithSeed).not.toHaveBeenCalled();
    // Its history is empty without asking Hermes.
    await expect(getHermesChatHistory(id)).resolves.toMatchObject({ messages: [] });
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("checks the DM in the agent's profile and keeps it when Hermes has it", async () => {
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-ana');
    resumeSession.mockResolvedValue({ sessionId: 'r-ana', messages: [] });
    const result = await openAgentDm({ agentSlug: 'ana' });
    expect(result.thread?.id).toBe('dm-ana');
    expect(resumeSession).toHaveBeenCalledWith('dm-ana', {
      historyBudget: 8000,
      profile: 'ana',
      omitMessages: true,
    });
  });

  it("moves a dead DM to the newest Boundary conversation in the agent's profile", async () => {
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-dead');
    resumeSession.mockRejectedValue(new Error('session not found'));
    listSessions.mockResolvedValue([
      { id: 's-old', title: 'Older', updatedAt: '2026-10-01T00:00:00.000Z', source: 'boundary' },
      { id: 's-new', title: 'Newer', updatedAt: '2026-10-14T00:00:00.000Z', source: 'boundary' },
      { id: 's-job', title: 'Board task', updatedAt: '2026-10-15T00:00:00.000Z', source: 'kanban' },
    ]);
    const result = await openAgentDm({ agentSlug: 'ana' });
    expect(listSessions).toHaveBeenCalledWith({ profile: 'ana' });
    expect(result).toMatchObject({ success: true, created: false, thread: { id: 's-new', kind: 'dm' } });
    expect(store.setStandingDmSessionId).toHaveBeenCalledWith('ana', 's-new');
    expect(store.setSessionAgentSlug).toHaveBeenCalledWith('s-new', 'ana');
  });

  it('opens the real conversation instead of an empty placeholder DM', async () => {
    const first = await openAgentDm({ agentSlug: 'ana' });
    vi.mocked(store.getStandingDmSessionId).mockReturnValue(first.thread!.id);
    listSessions.mockResolvedValue([
      { id: 's-real', title: 'Real', updatedAt: '2026-10-14T00:00:00.000Z', source: 'boundary' },
    ]);
    const second = await openAgentDm({ agentSlug: 'ana' });
    expect(second.thread?.id).toBe('s-real');
    expect(store.setStandingDmSessionId).toHaveBeenLastCalledWith('ana', 's-real');
  });

  it('replaces a dead DM with a placeholder when the agent has no other conversation', async () => {
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-dead');
    resumeSession.mockRejectedValue(new Error('session not found'));
    listSessions.mockResolvedValue([]);
    listWebuiSessions.mockResolvedValue([]);
    const result = await openAgentDm({ agentSlug: 'ana' });
    expect(result).toMatchObject({ success: true, created: true, thread: { kind: 'dm' } });
    expect(result.thread!.id).not.toBe('dm-dead');
    expect(store.setStandingDmSessionId).toHaveBeenCalledWith('ana', result.thread!.id);
    expect(createSessionWithSeed).not.toHaveBeenCalled();
  });

  it('keeps the DM when resume fails for another reason', async () => {
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-ana');
    resumeSession.mockRejectedValue(new Error('gateway not connected'));
    const result = await openAgentDm({ agentSlug: 'ana' });
    expect(result).toMatchObject({ success: true, created: false, thread: { id: 'dm-ana' } });
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
  });

  it('refuses a DM with the built-in agent or a missing agent', async () => {
    expect((await openAgentDm({ agentSlug: 'assistant' })).success).toBe(false);
    expect((await openAgentDm({ agentSlug: 'ghost' })).success).toBe(false);
    expect(createSessionWithSeed).not.toHaveBeenCalled();
  });
});

describe('claimNewSession (ADR 0023)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedSessionId.mockImplementation((id: string) => id);
  });

  it('never pins a Hermes chat', async () => {
    expect(claimNewSession('assistant', 's1')).toBe('hermes');
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
  });

  it("claims a personality's first session as its DM", async () => {
    vi.mocked(store.getStandingDmSessionId).mockReturnValue(null);
    claimNewSession('ana', 's1');
    expect(store.setStandingDmSessionId).toHaveBeenCalledWith('ana', 's1');
  });

  it('leaves an existing DM alone unless the new session replaces it', async () => {
    vi.mocked(store.getStandingDmSessionId).mockReturnValue('dm-ana');
    claimNewSession('ana', 's2');
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
    claimNewSession('ana', 's3', 'dm-ana');
    expect(store.setStandingDmSessionId).toHaveBeenCalledWith('ana', 's3');
  });
});

describe('branchHermesChat kinds (ADR 0023)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedSessionId.mockImplementation((id: string) => id);
    createSessionWithSeed.mockResolvedValue('branch-h');
  });

  it('branches a Hermes chat into another Hermes chat', async () => {
    vi.mocked(store.getSessionAgentSlug).mockReturnValue('assistant');
    const result = await branchHermesChat({
      parentSessionId: 'h-parent',
      seed: [{ role: 'user', content: 'hi' }],
    });
    expect(result.thread).toMatchObject({ kind: 'hermes', agentSlug: 'assistant' });
    expect(store.setStandingDmSessionId).not.toHaveBeenCalled();
  });
});
