import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentSlugFromDisplayName,
  BUILTIN_ASSISTANT_SLUG,
} from '../../../../../shared/types/hermesChat';

const getSessionAgentSlug = vi.fn();
const setSessionAgentSlug = vi.fn();
const getStandingDmMap = vi.fn();
const setStandingDmSessionId = vi.fn();
const getStandingDmSessionId = vi.fn();
const getStoredAgent = vi.fn();
const getChannelBySessionId = vi.fn();
const storedIds = new Map<string, string>();
const upsertStoredAgent = vi.fn();
const describeProfile = vi.fn();
const configureProfile = vi.fn();
const setSessionTitle = vi.fn();
const dataRoot = vi.hoisted(() => ({ dir: '' }));

vi.mock('../hermesAgentStore', () => ({
  getSessionAgentSlug: (...args: unknown[]) => getSessionAgentSlug(...args),
  setSessionAgentSlug: (...args: unknown[]) => setSessionAgentSlug(...args),
  getSessionChannelId: vi.fn().mockReturnValue(null),
  setSessionChannelId: vi.fn(),
  getStandingDmMap: (...args: unknown[]) => getStandingDmMap(...args),
  setStandingDmSessionId: (...args: unknown[]) => setStandingDmSessionId(...args),
  getStandingDmSessionId: (...args: unknown[]) => getStandingDmSessionId(...args),
  getChannelBySessionId: (...args: unknown[]) => getChannelBySessionId(...args),
  getStoredChannel: vi.fn().mockReturnValue(null),
  listStoredChannels: vi.fn().mockReturnValue([]),
  listStoredAgents: vi.fn().mockReturnValue([
    {
      slug: 'assistant',
      displayName: 'Hermes',
      handle: 'Hermes',
      role: 'Default',
      builtIn: true,
      createdAt: '1970-01-01T00:00:00.000Z',
    },
  ]),
  upsertStoredAgent: (...args: unknown[]) => upsertStoredAgent(...args),
  getStoredAgent: (...args: unknown[]) => getStoredAgent(...args),
}));

const setUpNewHermesProfile = vi.fn().mockResolvedValue(undefined);
vi.mock('../../AssistantStackService', () => ({
  setUpNewHermesProfile: (...args: unknown[]) => setUpNewHermesProfile(...args),
}));

vi.mock('../../resolveAssistantRoot', () => ({
  resolveActiveAssistantDataRoot: () => dataRoot.dir,
}));

vi.mock('../../assistantPaths', () => ({
  resolveAssistantDataRoot: () => '/tmp/boundary-test-assistant-data',
}));

const createProfile = vi.fn();
vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    ensureConnected: vi.fn(),
    createProfile: (...args: unknown[]) => createProfile(...args),
    createSessionWithSeed: vi.fn(),
    storedSessionId: (id: string) => storedIds.get(id) ?? id,
    describeProfile: (...args: unknown[]) => describeProfile(...args),
    configureProfile: (...args: unknown[]) => configureProfile(...args),
    setSessionTitle: (...args: unknown[]) => setSessionTitle(...args),
  }),
}));

describe('agentSlugFromDisplayName', () => {
  it('slugifies display names', () => {
    expect(agentSlugFromDisplayName('UI/UX Designer')).toBe('ui-ux-designer');
    expect(agentSlugFromDisplayName('  Staff Recruiter  ')).toBe('staff-recruiter');
  });
});

describe('annotateThreadsWithAgents (ADR 0023)', () => {
  let standing: Record<string, string | null>;
  let meta: Map<string, string>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storedIds.clear();
    standing = {};
    getStandingDmMap.mockImplementation(() => ({ ...standing }));
    getStandingDmSessionId.mockImplementation((slug: string) => standing[slug] ?? null);
    setStandingDmSessionId.mockImplementation((slug: string, id: string | null) => {
      standing[slug] = id;
    });
    meta = new Map<string, string>();
    getSessionAgentSlug.mockImplementation((id: string) => meta.get(id) ?? null);
    setSessionAgentSlug.mockImplementation((id: string, slug: string) => {
      meta.set(id, slug);
    });
    getChannelBySessionId.mockReturnValue(null);
  });

  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();

  it('classifies channel, built-in, standing, non-standing, external and unknown owners', async () => {
    standing = { ana: 'ana-dm' };
    meta.set('hermes-1', BUILTIN_ASSISTANT_SLUG);
    meta.set('ana-dm', 'ana');
    meta.set('ana-old', 'ana');
    meta.set('gone-1', 'deleted-agent');
    getChannelBySessionId.mockImplementation((id: string) =>
      id === 'room' ? { id: 'ch1', slug: 'research', sessionId: 'room', memberSlugs: [] } : null
    );
    const { annotateThreadsWithAgents } = await import('../hermesAgents');
    const threads = annotateThreadsWithAgents([
      { id: 'room', title: 'room', updatedAt: at(1) },
      { id: 'hermes-1', title: 'Plan', updatedAt: at(2) },
      { id: 'ana-dm', title: 'DM · Ana', updatedAt: at(3) },
      { id: 'ana-old', title: 'Older Ana chat', updatedAt: at(4) },
      { id: 'tg-1', title: 'Groceries', source: 'telegram', updatedAt: at(5) },
      { id: 'gone-1', title: 'Orphan', updatedAt: at(6) },
    ]);
    const byId = Object.fromEntries(threads.map((t) => [t.id, t]));

    expect(byId.room).toMatchObject({ kind: 'channel', channelSlug: 'research' });
    expect(byId['hermes-1']).toMatchObject({ kind: 'hermes', agentSlug: BUILTIN_ASSISTANT_SLUG });
    expect(byId['ana-dm']).toMatchObject({ kind: 'dm', agentSlug: 'ana' });
    expect(byId['ana-old']).toMatchObject({ kind: 'side', agentSlug: 'ana' });
    expect(byId['tg-1']).toMatchObject({
      kind: 'hermes',
      agentSlug: BUILTIN_ASSISTANT_SLUG,
      source: 'telegram',
    });
    // The transcript lives in that profile, so it stays the agent's side chat.
    expect(byId['gone-1']).toMatchObject({ kind: 'side', agentSlug: 'deleted-agent' });
    expect(threads).toHaveLength(6);
  });

  it('turns every pre-0023 Assistant session into a Hermes chat and never pins one', async () => {
    // Before 0023 the newest Assistant session was its standing DM; the store drops that key.
    const { annotateThreadsWithAgents } = await import('../hermesAgents');
    const threads = annotateThreadsWithAgents([
      { id: 'was-standing', title: 'Newest', updatedAt: at(1) },
      { id: 'was-leftover', title: 'Older', updatedAt: at(9) },
    ]);
    expect(threads.map((t) => t.kind)).toEqual(['hermes', 'hermes']);
    expect(setStandingDmSessionId).not.toHaveBeenCalled();
  });

  it('is idempotent across repeated lists', async () => {
    standing = { ana: 'ana-dm' };
    meta.set('ana-dm', 'ana');
    const { annotateThreadsWithAgents } = await import('../hermesAgents');
    const input = [
      { id: 'ana-dm', title: 'DM', updatedAt: at(1) },
      { id: 'x', title: 'Hermes', updatedAt: at(2) },
    ];
    const first = annotateThreadsWithAgents(input);
    const second = annotateThreadsWithAgents(input);
    expect(second).toEqual(first);
  });

  it('matches a standing DM saved under its runtime id', async () => {
    standing = { ana: 'runtime-7' };
    storedIds.set('runtime-7', 'stored-7');
    meta.set('stored-7', 'ana');
    const { annotateThreadsWithAgents } = await import('../hermesAgents');
    const [thread] = annotateThreadsWithAgents([{ id: 'stored-7', title: 'DM', updatedAt: at(1) }]);
    expect(thread.kind).toBe('dm');
  });
});

describe('createHermesAgent', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it.each([
    [{ displayName: 'Hermes', role: 'Researcher' }],
    [{ displayName: 'hermes ', role: 'Researcher' }],
    [{ displayName: 'Ana', handle: '@Hermes', role: 'Researcher' }],
  ])('refuses the built-in agent name (%o)', async (payload) => {
    const { createHermesAgent } = await import('../hermesAgents');
    const result = await createHermesAgent(payload);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Hermes');
  });

  it('sets up the new profile with what the stack bootstrap never wrote', async () => {
    dataRoot.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-agents-'));
    setUpNewHermesProfile.mockClear();
    const { createHermesAgent } = await import('../hermesAgents');
    const result = await createHermesAgent({ displayName: 'Researcher', role: 'Finds sources.' });
    expect(result.success).toBe(true);
    await vi.waitFor(() =>
      expect(setUpNewHermesProfile).toHaveBeenCalledWith(result.agent?.slug)
    );
  });

  it('tells a new agent where calendar access is changed (calendar spec, Phase 3)', async () => {
    createProfile.mockClear();
    const { createHermesAgent } = await import('../hermesAgents');
    await createHermesAgent({ displayName: 'Scheduler', role: 'Keeps the week in order.' });
    const soul = (createProfile.mock.calls[0]?.[0] as { soul: string }).soul;
    expect(soul).toContain('## Calendars');
    expect(soul).toContain('Settings → Calendars');
  });
});

describe('updateHermesAgent (ADR 0010 §4)', () => {
  const ana = {
    slug: 'ana',
    displayName: 'Ana',
    handle: 'ana',
    role: 'Find vendors.',
    builtIn: false,
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  const soulPath = () => path.join(dataRoot.dir, 'hermes', 'profiles', 'ana', 'SOUL.md');
  const writeSoul = (text: string) => {
    fs.mkdirSync(path.dirname(soulPath()), { recursive: true });
    fs.writeFileSync(soulPath(), text);
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    dataRoot.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-agent-edit-'));
    getStoredAgent.mockImplementation((slug: string) => (slug === 'ana' ? ana : null));
    getStandingDmSessionId.mockReturnValue('dm-ana');
    configureProfile.mockResolvedValue({ ok: true });
    setSessionTitle.mockResolvedValue(undefined);
    describeProfile.mockResolvedValue({ soul: null });
  });

  afterEach(() => {
    fs.rmSync(dataRoot.dir, { recursive: true, force: true });
  });

  it('saves the new name, handle and role, and writes them into the profile', async () => {
    writeSoul('# Ana\n\nFind vendors.\n\n## Memory\n');
    const { updateHermesAgent } = await import('../hermesAgents');
    const result = await updateHermesAgent({
      slug: 'ana',
      displayName: 'Ana Pricing',
      handle: '@ana-p',
      role: 'Compare pricing.',
    });
    expect(result).toEqual({
      success: true,
      agent: { ...ana, displayName: 'Ana Pricing', handle: 'ana-p', role: 'Compare pricing.' },
    });
    expect(configureProfile).toHaveBeenCalledWith('ana', {
      description: 'Compare pricing.',
      soul: '# Ana Pricing\n\nCompare pricing.\n\n## Memory\n',
    });
    expect(upsertStoredAgent).toHaveBeenCalledWith(result.agent);
    expect(setSessionTitle).toHaveBeenCalledWith('dm-ana', 'DM · Ana Pricing');
  });

  it('keeps a hand-edited soul and says so', async () => {
    writeSoul('# Ana, vendor hunter\n\nMy own instructions.\n');
    const { updateHermesAgent } = await import('../hermesAgents');
    const result = await updateHermesAgent({ slug: 'ana', displayName: 'Ana', role: 'Compare.' });
    expect(result).toMatchObject({ success: true, soulKept: true });
    expect(configureProfile).toHaveBeenCalledWith('ana', { description: 'Compare.' });
    expect(setSessionTitle).not.toHaveBeenCalled();
  });

  it('changes only Boundary’s record for a new handle', async () => {
    const { updateHermesAgent } = await import('../hermesAgents');
    const result = await updateHermesAgent({
      slug: 'ana',
      displayName: 'Ana',
      handle: 'vendors',
      role: 'Find vendors.',
    });
    expect(result.agent?.handle).toBe('vendors');
    expect(configureProfile).not.toHaveBeenCalled();
  });

  it('saves even when Hermes refuses, and reports it', async () => {
    configureProfile.mockRejectedValue(new Error('gateway down'));
    const { updateHermesAgent } = await import('../hermesAgents');
    const result = await updateHermesAgent({ slug: 'ana', displayName: 'Ana', role: 'Compare.' });
    expect(result.success).toBe(true);
    expect(result.error).toContain('gateway down');
    expect(upsertStoredAgent).toHaveBeenCalled();
  });

  it('refuses the built-in agent, its name, and an empty role', async () => {
    getStoredAgent.mockImplementation((slug: string) =>
      slug === 'assistant'
        ? { ...ana, slug: 'assistant', displayName: 'Hermes', builtIn: true }
        : slug === 'ana'
          ? ana
          : null
    );
    const { updateHermesAgent } = await import('../hermesAgents');
    const builtIn = await updateHermesAgent({ slug: 'assistant', displayName: 'H', role: 'x' });
    expect(builtIn.success).toBe(false);
    const named = await updateHermesAgent({ slug: 'ana', displayName: 'Hermes', role: 'x' });
    expect(named.error).toContain('Hermes');
    expect((await updateHermesAgent({ slug: 'ana', displayName: 'Ana', role: ' ' })).success).toBe(
      false
    );
    expect(upsertStoredAgent).not.toHaveBeenCalled();
  });
});

describe('historyBudgetFor (CR 0002 R1)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storedIds.clear();
    getStandingDmMap.mockReturnValue({ ana: 'dm-ana' });
    const owners: Record<string, string> = {
      'dm-ana': 'ana',
      'side-ana': 'ana',
      'chat-1': BUILTIN_ASSISTANT_SLUG,
    };
    getSessionAgentSlug.mockImplementation((id: string) => owners[id] ?? null);
  });

  it('gives a DM the budget and nothing else one', async () => {
    const { historyBudgetFor, DM_HISTORY_BUDGET } = await import('../hermesAgents');
    expect(historyBudgetFor('dm-ana')).toBe(DM_HISTORY_BUDGET);
    expect(historyBudgetFor('side-ana')).toBeUndefined();
    expect(historyBudgetFor('chat-1')).toBeUndefined();
    expect(historyBudgetFor('unknown')).toBeUndefined();
  });

  it('knows a DM by its runtime id too', async () => {
    storedIds.set('runtime-ana', 'dm-ana');
    getSessionAgentSlug.mockImplementation((id: string) => (id === 'runtime-ana' ? 'ana' : null));
    const { historyBudgetFor, DM_HISTORY_BUDGET } = await import('../hermesAgents');
    expect(historyBudgetFor('runtime-ana')).toBe(DM_HISTORY_BUDGET);
  });
});
