import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorRecord } from '../hermesAgentStore';

const state = vi.hoisted(() => ({
  record: null as OrchestratorRecord | null,
  agents: new Set<string>(),
  roles: new Map<string, string>(),
}));
const createHermesAgent = vi.fn();
const updateHermesAgent = vi.fn();
const enableProfileToolsets = vi.fn();
const createSessionWithSeed = vi.fn();
const broadcastSessionsChanged = vi.fn();
const openListeners = vi.hoisted(() => new Set<() => void>());

vi.mock('../hermesAgents', () => ({
  createHermesAgent: (...args: unknown[]) => createHermesAgent(...args),
  updateHermesAgent: (...args: unknown[]) => updateHermesAgent(...args),
}));

vi.mock('../hermesAgentStore', () => ({
  getOrchestratorRecord: () => state.record,
  setOrchestratorRecord: (record: OrchestratorRecord) => {
    state.record = record;
  },
  getStoredAgent: (slug: string) =>
    state.agents.has(slug)
      ? { slug, displayName: 'Orchestrator', handle: slug, role: state.roles.get(slug) ?? 'Custom.' }
      : null,
}));

vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    enableProfileToolsets: (...args: unknown[]) => enableProfileToolsets(...args),
    createSessionWithSeed: (...args: unknown[]) => createSessionWithSeed(...args),
    onOpen: (listener: () => void) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
  }),
}));

vi.mock('../hermesSessionsChanged', () => ({
  broadcastSessionsChanged: () => broadcastSessionsChanged(),
}));

import {
  ensureOrchestratorAgent,
  ORCHESTRATOR_DISPLAY_NAME,
  ORCHESTRATOR_ROLE,
  resetOrchestratorForTests,
  retryOrchestratorOnGatewayOpen,
} from '../hermesOrchestrator';

/** The role before stack v0.3.3 refused worktrees on the coding repos. */
function worktreeRole(): string {
  return ORCHESTRATOR_ROLE.replace(
    / File every task with workspace_kind "scratch"\..*?can work there\./,
    ' Give every task a workspace the worker can run in: workspace_kind "dir" with an absolute' +
      ' workspace_path for work inside an existing folder or project, "worktree" with the absolute' +
      ' path of the git repo it branches from, or "scratch" for work that needs no files.' +
      ' Never leave workspace_path empty for "dir" or "worktree": the board has no default folder,' +
      ' so such a task is blocked before it starts.'
  ).replace(/ When a task gives up because.*?with kanban_archive\./, '');
}

describe('ensureOrchestratorAgent', () => {
  beforeEach(() => {
    state.record = null;
    state.agents.clear();
    state.roles.clear();
    updateHermesAgent.mockReset().mockResolvedValue({ success: true });
    createHermesAgent.mockReset().mockImplementation(async () => {
      state.agents.add('orchestrator');
      return { success: true, agent: { slug: 'orchestrator' } };
    });
    enableProfileToolsets.mockReset().mockResolvedValue(true);
    createSessionWithSeed.mockReset().mockResolvedValue('setup-1');
    broadcastSessionsChanged.mockReset();
    openListeners.clear();
    resetOrchestratorForTests();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates the agent and turns kanban on in its profile through a session of its own', async () => {
    await ensureOrchestratorAgent();
    expect(createHermesAgent).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: ORCHESTRATOR_DISPLAY_NAME, handle: 'orchestrator' })
    );
    expect(createSessionWithSeed).toHaveBeenCalledWith({ profile: 'orchestrator' });
    expect(enableProfileToolsets).toHaveBeenCalledWith('setup-1', ['kanban'], 'orchestrator');
    expect(state.record).toEqual({ slug: 'orchestrator', kanbanEnabled: true });
    expect(broadcastSessionsChanged).toHaveBeenCalledTimes(1);
  });

  it('does nothing once set up', async () => {
    await ensureOrchestratorAgent();
    await ensureOrchestratorAgent();
    expect(createHermesAgent).toHaveBeenCalledTimes(1);
    expect(enableProfileToolsets).toHaveBeenCalledTimes(1);
  });

  it('retries only the toolset step when it failed, after a wait', async () => {
    enableProfileToolsets.mockRejectedValueOnce(new Error('session not found'));
    await ensureOrchestratorAgent();
    expect(state.record).toEqual({ slug: 'orchestrator', kanbanEnabled: false });

    vi.setSystemTime(30_000);
    await ensureOrchestratorAgent();
    expect(createHermesAgent).toHaveBeenCalledTimes(1);
    expect(enableProfileToolsets).toHaveBeenCalledTimes(2);
    expect(state.record).toEqual({ slug: 'orchestrator', kanbanEnabled: true });
  });

  it('backs off between failed attempts instead of retrying on every call', async () => {
    enableProfileToolsets.mockResolvedValue(false);
    await ensureOrchestratorAgent();
    expect(enableProfileToolsets).toHaveBeenCalledTimes(1);

    // List refreshes inside the wait don't call Hermes again.
    vi.setSystemTime(29_999);
    await ensureOrchestratorAgent();
    expect(enableProfileToolsets).toHaveBeenCalledTimes(1);

    vi.setSystemTime(30_000);
    await ensureOrchestratorAgent();
    expect(enableProfileToolsets).toHaveBeenCalledTimes(2);

    // The second failure doubles the wait.
    vi.setSystemTime(30_000 + 59_999);
    await ensureOrchestratorAgent();
    expect(enableProfileToolsets).toHaveBeenCalledTimes(2);
    vi.setSystemTime(30_000 + 60_000);
    await ensureOrchestratorAgent();
    expect(enableProfileToolsets).toHaveBeenCalledTimes(3);
  });

  it('retries at once when the gateway opens, without waiting out the backoff', async () => {
    retryOrchestratorOnGatewayOpen();
    createHermesAgent.mockResolvedValueOnce({ success: false, error: 'gateway not up' });
    await ensureOrchestratorAgent();
    expect(state.record).toBeNull();

    // Inside the 30 s wait a list refresh does nothing, but the gateway opening does.
    vi.setSystemTime(1_000);
    await ensureOrchestratorAgent();
    expect(createHermesAgent).toHaveBeenCalledTimes(1);
    for (const listener of openListeners) listener();
    // The open started a run; this call joins it rather than starting another.
    await ensureOrchestratorAgent();
    expect(state.record).toEqual({ slug: 'orchestrator', kanbanEnabled: true });
    expect(createHermesAgent).toHaveBeenCalledTimes(2);
  });

  it('does nothing on a gateway open once set up', async () => {
    retryOrchestratorOnGatewayOpen();
    await ensureOrchestratorAgent();
    for (const listener of openListeners) listener();
    await ensureOrchestratorAgent();
    expect(createHermesAgent).toHaveBeenCalledTimes(1);
    expect(enableProfileToolsets).toHaveBeenCalledTimes(1);
  });

  it('adopts an existing orchestrator agent instead of making a second one', async () => {
    state.agents.add('orchestrator');
    await ensureOrchestratorAgent();
    expect(createHermesAgent).not.toHaveBeenCalled();
    expect(enableProfileToolsets).toHaveBeenCalledWith('setup-1', ['kanban'], 'orchestrator');
  });

  it('shares one run between concurrent callers', async () => {
    await Promise.all([ensureOrchestratorAgent(), ensureOrchestratorAgent()]);
    expect(createHermesAgent).toHaveBeenCalledTimes(1);
  });

  it('leaves no record when creation fails, so it tries again', async () => {
    createHermesAgent.mockResolvedValueOnce({ success: false, error: 'nope' });
    await ensureOrchestratorAgent();
    expect(state.record).toBeNull();
  });

  it('moves an orchestrator still on the first built-in role to the current one', async () => {
    const first = [
      'Coordinate long-running, multi-step work on the Hermes kanban board.',
      'When a request will take many steps or outlast one sitting, break it into tasks with kanban_create:',
      'a clear title, a body that says what done looks like, and an assignee (yourself, or the',
      'specialist agent whose role fits). Unassigned tasks never run, so always set one.',
      'Chain tasks that depend on each other with kanban_link.',
      'Track them with kanban_list and kanban_show, unblock or answer tasks that are waiting,',
      'and tell the owner what finished and what is still open.',
      'Handle quick, single-step requests yourself without the board.',
    ].join(' ');
    state.agents.add('orchestrator');
    state.roles.set('orchestrator', first);
    state.record = { slug: 'orchestrator', kanbanEnabled: true };
    await ensureOrchestratorAgent();
    expect(updateHermesAgent).toHaveBeenCalledWith({
      slug: 'orchestrator',
      displayName: 'Orchestrator',
      handle: 'orchestrator',
      role: ORCHESTRATOR_ROLE,
    });
  });

  it('moves an orchestrator on the role without a runtime cap to the current one', async () => {
    const withoutCap = worktreeRole().replace(
      / Set max_runtime_seconds on every task: .*? the cap is the only thing that stops it\./,
      ''
    );
    expect(withoutCap).not.toBe(ORCHESTRATOR_ROLE);
    state.agents.add('orchestrator');
    state.roles.set('orchestrator', withoutCap);
    state.record = { slug: 'orchestrator', kanbanEnabled: true };
    await ensureOrchestratorAgent();
    expect(updateHermesAgent).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'orchestrator', role: ORCHESTRATOR_ROLE })
    );
    expect(ORCHESTRATOR_ROLE).toContain('max_runtime_seconds');
  });

  it('moves an orchestrator on the role that asked for worktrees to the scratch one', async () => {
    const withWorktrees = worktreeRole();
    expect(withWorktrees).not.toBe(ORCHESTRATOR_ROLE);
    state.agents.add('orchestrator');
    state.roles.set('orchestrator', withWorktrees);
    state.record = { slug: 'orchestrator', kanbanEnabled: true };
    await ensureOrchestratorAgent();
    expect(updateHermesAgent).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'orchestrator', role: ORCHESTRATOR_ROLE })
    );
    expect(ORCHESTRATOR_ROLE).toContain('kanban_update(workspace_kind="scratch")');
  });

  it("leaves a role the owner rewrote alone", async () => {
    state.agents.add('orchestrator');
    state.roles.set('orchestrator', 'My own instructions.');
    state.record = { slug: 'orchestrator', kanbanEnabled: true };
    await ensureOrchestratorAgent();
    expect(updateHermesAgent).not.toHaveBeenCalled();
  });
});
