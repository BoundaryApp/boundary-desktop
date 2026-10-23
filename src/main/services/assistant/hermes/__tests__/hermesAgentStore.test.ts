import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendSessionInferenceMark,
  clearSessionInference,
  clearSessionInferenceForProvider,
  getSessionAgentSlug,
  getSessionChannelId,
  getSessionInference,
  getStandingDmMap,
  getStoredAgent,
  listStoredAgents,
  setStandingDmSessionId,
  listSessionInferenceMarks,
  resetHermesAgentsStoreForTests,
  setSessionAgentSlug,
  setSessionChannelId,
  setSessionInference,
  getSessionProjectId,
  setSessionProjectIds,
  setStoredSessionAlias,
} from '../hermesAgentStore';

describe('hermesAgentStore session inference', () => {
  beforeEach(() => {
    resetHermesAgentsStoreForTests();
  });

  it('keeps inference when agent slug or channel is updated', () => {
    setSessionInference('s1', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' });
    setSessionAgentSlug('s1', 'researcher');
    setSessionChannelId('s1', 'ch-1');
    expect(getSessionInference('s1')).toEqual({
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
    });
    expect(getSessionAgentSlug('s1')).toBe('researcher');
    expect(getSessionChannelId('s1')).toBe('ch-1');
  });

  it('sets, lists marks, and clears an override', () => {
    setSessionInference('s1', { provider: 'local', modelId: 'qwen3:14b' });
    appendSessionInferenceMark('s1', {
      kind: 'switched',
      provider: 'local',
      modelId: 'qwen3:14b',
    });
    expect(listSessionInferenceMarks('s1')).toHaveLength(1);
    clearSessionInference('s1');
    expect(getSessionInference('s1')).toBeNull();
    expect(getSessionAgentSlug('s1')).toBe('assistant');
  });

  it('sweeps overrides for a disconnected provider', () => {
    setSessionInference('a', { provider: 'local', modelId: 'qwen3:14b' });
    setSessionInference('b', { provider: 'openrouter', modelId: 'openai/gpt-4o' });
    clearSessionInferenceForProvider('local');
    expect(getSessionInference('a')).toBeNull();
    expect(getSessionInference('b')?.provider).toBe('openrouter');
  });
});

describe('hermesAgentStore built-in agent (ADR 0023)', () => {
  const legacy = {
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

  it('names the built-in Hermes on a fresh store', () => {
    resetHermesAgentsStoreForTests();
    const builtin = getStoredAgent('assistant');
    expect(builtin?.displayName).toBe('Hermes');
    expect(builtin?.handle).toBe('Hermes');
  });

  it('renames an untouched Assistant record and keeps the slug and other agents', () => {
    resetHermesAgentsStoreForTests([legacy, ana]);
    const agents = listStoredAgents();
    expect(agents.map((a) => a.slug)).toEqual(['assistant', 'ana']);
    expect(agents[0]).toMatchObject({
      slug: 'assistant',
      displayName: 'Hermes',
      handle: 'Hermes',
      builtIn: true,
      createdAt: legacy.createdAt,
    });
    expect(agents[1]).toEqual(ana);
  });

  it('leaves a built-in record that is no longer the legacy default', () => {
    const filled = { ...legacy, displayName: 'Atlas', handle: 'Atlas' };
    resetHermesAgentsStoreForTests([filled]);
    expect(getStoredAgent('assistant')).toEqual(filled);
  });
});

describe('hermesAgentStore standing DMs (ADR 0023)', () => {
  it("drops the built-in agent's pre-0023 standing DM and keeps personalities'", () => {
    resetHermesAgentsStoreForTests(undefined, { assistant: 'old-standing', ana: 'dm-ana' });
    expect(getStandingDmMap()).toEqual({ ana: 'dm-ana' });
    // Persisted: a second read sees the same map.
    expect(getStandingDmMap()).toEqual({ ana: 'dm-ana' });
  });

  it('never pins a standing DM for the built-in agent', () => {
    resetHermesAgentsStoreForTests();
    setStandingDmSessionId('assistant', 's1');
    setStandingDmSessionId('ana', 's2');
    expect(getStandingDmMap()).toEqual({ ana: 's2' });
  });
});

describe('hermesAgentStore per stack', () => {
  const prevRoot = process.env.BOUNDARY_ASSISTANT_ROOT;

  afterEach(() => {
    if (prevRoot === undefined) {
      delete process.env.BOUNDARY_ASSISTANT_ROOT;
    } else {
      process.env.BOUNDARY_ASSISTANT_ROOT = prevRoot;
    }
  });

  it('keeps each stack’s records apart', () => {
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    resetHermesAgentsStoreForTests();
    setSessionAgentSlug('managed-session', 'researcher');

    process.env.BOUNDARY_ASSISTANT_ROOT = '/dev/local-assistant';
    resetHermesAgentsStoreForTests();
    expect(getSessionAgentSlug('managed-session')).toBeNull();
    setSessionAgentSlug('local-session', 'designer');

    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    expect(getSessionAgentSlug('managed-session')).toBe('researcher');
    expect(getSessionAgentSlug('local-session')).toBeNull();
  });
});

describe('hermesAgentStore records kept under a runtime id', () => {
  beforeEach(() => {
    resetHermesAgentsStoreForTests();
  });

  it("finds a stored session's agent and folder recorded under its runtime id", () => {
    setSessionAgentSlug('r1', 'orchestrator');
    setSessionProjectIds({ r1: 'journal' });
    setStoredSessionAlias('r1', 's1');
    expect(getSessionAgentSlug('s1')).toBe('orchestrator');
    expect(getSessionProjectId('s1')).toBe('journal');
  });

  it("keeps the agent when a stored session is filed under a folder", () => {
    setSessionAgentSlug('r1', 'orchestrator');
    setStoredSessionAlias('r1', 's1');
    setSessionProjectIds({ s1: 'journal' });
    expect(getSessionAgentSlug('s1')).toBe('orchestrator');
  });
});
