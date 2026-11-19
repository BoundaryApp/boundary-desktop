import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendPoolServedTurn,
  appendSessionInferenceMark,
  appendSessionTurnWindow,
  closeSessionTurnWindow,
  deleteFailedChat,
  listPoolServedTurns,
  listSessionTurnWindows,
  migrateSessionInference,
  clearSessionInference,
  clearSessionInferenceForProvider,
  getSessionAgentSlug,
  getSessionChannelId,
  getSessionInference,
  getStandingDmMap,
  getStoredAgent,
  setStandingDmSessionId,
  listSessionInferenceMarks,
  resetHermesAgentsStoreForTests,
  retargetSessionInferenceModel,
  setSessionAgentSlug,
  setSessionChannelId,
  setSessionInference,
  getSessionProjectId,
  setSessionProjectIds,
  setStoredSessionAlias,
  listStoredAgents,
  upsertStoredAgent,
  updateStoredAgentVoices,
  appendSessionWritingVoiceMark,
  getSessionWritingVoice,
  listSessionWritingVoiceMarks,
  moveSessionWritingVoice,
  getRoomVoiceSent,
  setRoomVoiceSent,
  setSessionWritingVoice,
} from '../hermesAgentStore';
import { setBuiltinAgentNameSource } from '../builtinAgentName';
import type { PoolServedTurn } from '../../../../../shared/types/hermesChat';

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

  it('moves overrides for a provider to its newly saved model', () => {
    setSessionInference('a', { provider: 'openrouter', modelId: 'openai/gpt-4o' });
    setSessionInference('b', { provider: 'local', modelId: 'qwen3:14b' });
    setSessionAgentSlug('a', 'researcher');
    retargetSessionInferenceModel('openrouter', 'openai/gpt-5.1');
    expect(getSessionInference('a')).toEqual({
      provider: 'openrouter',
      modelId: 'openai/gpt-5.1',
    });
    expect(getSessionAgentSlug('a')).toBe('researcher');
    expect(getSessionInference('b')?.modelId).toBe('qwen3:14b');
  });
});

describe('hermesAgentStore pool turns', () => {
  beforeEach(() => {
    resetHermesAgentsStoreForTests();
  });

  const turn = (n: number): PoolServedTurn => ({
    at: new Date(n * 1_000).toISOString(),
    windowStartedAt: new Date(n * 1_000 - 100).toISOString(),
    modelId: 'qwen-3-8',
    providerId: 'near',
    providerName: 'NEAR AI',
    level: 'B',
    moved: null,
    mixedProviders: false,
  });

  it('keeps only the record’s own fields', () => {
    appendPoolServedTurn('s1', { ...turn(1), text: 'a reply' } as PoolServedTurn);
    expect(listPoolServedTurns('s1')).toEqual([turn(1)]);
    expect(listPoolServedTurns('s2')).toEqual([]);
  });

  it('keeps the newest 200 per session', () => {
    for (let n = 1; n <= 205; n += 1) appendPoolServedTurn('s1', turn(n));
    const kept = listPoolServedTurns('s1');
    expect(kept).toHaveLength(200);
    expect(kept[0]).toEqual(turn(6));
    expect(kept.at(-1)).toEqual(turn(205));
  });

  const window = (n: number, endedAt: string | null = null) => ({
    startedAt: new Date(n * 1_000).toISOString(),
    endedAt,
    run: 'run-1',
  });

  it('moves with the session to its stored id, with its turn windows', () => {
    appendPoolServedTurn('runtime', turn(1));
    appendSessionTurnWindow('runtime', window(1));
    appendSessionTurnWindow('stored', window(0));
    migrateSessionInference('runtime', 'stored');
    expect(listPoolServedTurns('stored')).toEqual([turn(1)]);
    expect(listPoolServedTurns('runtime')).toEqual([]);
    expect(listSessionTurnWindows('stored')).toEqual([window(0), window(1)]);
    expect(listSessionTurnWindows('runtime')).toEqual([]);
  });

  it('keeps the newest 200 turn windows per session', () => {
    for (let n = 1; n <= 205; n += 1) appendSessionTurnWindow('s1', window(n));
    const kept = listSessionTurnWindows('s1');
    expect(kept).toHaveLength(200);
    expect(kept[0]).toEqual(window(6));
  });

  it('keeps pool turns and turn windows for the 1,000 most recently active chats', () => {
    // s0 is the oldest chat until it gets a new turn; s1 then becomes the oldest.
    for (let n = 0; n < 1_000; n += 1) {
      appendPoolServedTurn(`s${n}`, turn(n + 1));
      appendSessionTurnWindow(`s${n}`, window(n + 1));
    }
    appendPoolServedTurn('s0', turn(2_000));
    appendSessionTurnWindow('s0', window(2_000));
    appendPoolServedTurn('new', turn(3_000));
    appendSessionTurnWindow('new', window(3_000));
    expect(listPoolServedTurns('s1')).toEqual([]);
    expect(listSessionTurnWindows('s1')).toEqual([]);
    expect(listPoolServedTurns('s0')).toEqual([turn(1), turn(2_000)]);
    expect(listSessionTurnWindows('s0')).toHaveLength(2);
    expect(listPoolServedTurns('s2')).toEqual([turn(3)]);
    expect(listSessionTurnWindows('new')).toEqual([window(3_000)]);
  });

  it('keeps only a window’s times and run', () => {
    appendSessionTurnWindow('s1', { ...window(1), text: 'a prompt' } as ReturnType<typeof window>);
    expect(listSessionTurnWindows('s1')).toEqual([window(1)]);
  });

  it('ends only the open window that began at the given time', () => {
    appendSessionTurnWindow('s1', window(1));
    appendSessionTurnWindow('s1', window(2));
    const ended = new Date(3_000).toISOString();
    expect(closeSessionTurnWindow('s1', window(1).startedAt, ended)).toBe(true);
    expect(listSessionTurnWindows('s1')).toEqual([window(1, ended), window(2)]);
    // Already ended, or not this session's: nothing changes.
    expect(closeSessionTurnWindow('s1', window(1).startedAt, new Date(4_000).toISOString())).toBe(false);
    expect(closeSessionTurnWindow('s2', window(2).startedAt, ended)).toBe(false);
    expect(listSessionTurnWindows('s1')).toEqual([window(1, ended), window(2)]);
  });

  it('goes with a deleted chat, under its runtime and stored ids, and leaves other chats', () => {
    setStoredSessionAlias('runtime', 'stored');
    appendPoolServedTurn('stored', turn(1));
    appendSessionTurnWindow('stored', window(1));
    appendSessionTurnWindow('runtime', window(2));
    appendPoolServedTurn('other', turn(3));
    appendSessionTurnWindow('other', window(3));
    deleteFailedChat('runtime');
    expect(listPoolServedTurns('stored')).toEqual([]);
    expect(listSessionTurnWindows('stored')).toEqual([]);
    expect(listSessionTurnWindows('runtime')).toEqual([]);
    expect(listPoolServedTurns('other')).toEqual([turn(3)]);
    expect(listSessionTurnWindows('other')).toEqual([window(3)]);
  });
});

describe('hermesAgentStore built-in agent (ADR 0023)', () => {
  it('names the built-in Hermes on a fresh store', () => {
    resetHermesAgentsStoreForTests();
    const builtin = getStoredAgent('assistant');
    expect(builtin?.displayName).toBe('Hermes');
    expect(builtin?.handle).toBe('Hermes');
  });
});

describe('hermesAgentStore built-in agent name source', () => {
  afterEach(() => setBuiltinAgentNameSource(null));

  it('lists the built-in agent under the name the source gives, as name and handle', () => {
    resetHermesAgentsStoreForTests();
    setBuiltinAgentNameSource(() => ' Marlow ');
    expect(getStoredAgent('assistant')).toMatchObject({ displayName: 'Marlow', handle: 'Marlow' });
    expect(listStoredAgents()[0]).toMatchObject({ slug: 'assistant', displayName: 'Marlow' });
  });

  it('keeps the stored name when the source is blank or throws', () => {
    resetHermesAgentsStoreForTests();
    setBuiltinAgentNameSource(() => '   ');
    expect(getStoredAgent('assistant')?.displayName).toBe('Hermes');
    setBuiltinAgentNameSource(() => {
      throw new Error('store unreadable');
    });
    expect(getStoredAgent('assistant')?.displayName).toBe('Hermes');
  });

  it("sets the built-in agent's voices without storing its supplied name", () => {
    resetHermesAgentsStoreForTests();
    setBuiltinAgentNameSource(() => 'Marlow');
    expect(updateStoredAgentVoices('assistant', { chatRepliesVoiceId: 'plain', draftsVoiceId: null })).toMatchObject({
      displayName: 'Marlow',
      chatRepliesVoiceId: 'plain',
    });
    setBuiltinAgentNameSource(null);
    expect(getStoredAgent('assistant')).toMatchObject({ displayName: 'Hermes', chatRepliesVoiceId: 'plain' });
    expect(updateStoredAgentVoices('nobody', { chatRepliesVoiceId: null, draftsVoiceId: null })).toBeNull();
  });

  it('never writes the supplied name into the stored record', () => {
    resetHermesAgentsStoreForTests();
    setBuiltinAgentNameSource(() => 'Marlow');
    upsertStoredAgent({
      slug: 'researcher',
      displayName: 'Researcher',
      handle: 'Researcher',
      role: 'Finds things.',
      builtIn: false,
      createdAt: '2026-11-03T00:00:00.000Z',
    });
    setBuiltinAgentNameSource(null);
    expect(getStoredAgent('assistant')?.displayName).toBe('Hermes');
    expect(getStoredAgent('researcher')?.displayName).toBe('Researcher');
  });

  it('leaves other agents alone', () => {
    resetHermesAgentsStoreForTests();
    setBuiltinAgentNameSource(() => 'Marlow');
    upsertStoredAgent({
      slug: 'researcher',
      displayName: 'Researcher',
      handle: 'Researcher',
      role: 'Finds things.',
      builtIn: false,
      createdAt: '2026-11-03T00:00:00.000Z',
    });
    expect(getStoredAgent('researcher')?.displayName).toBe('Researcher');
  });
});

describe('hermesAgentStore standing DMs (ADR 0023)', () => {
  it('never pins a standing DM for the built-in agent', () => {
    resetHermesAgentsStoreForTests();
    setStandingDmSessionId('assistant', 's1');
    setStandingDmSessionId('ana', 's2');
    expect(getStandingDmMap()).toEqual({ ana: 's2' });
  });
});

describe('hermesAgentStore per stack', () => {
  it('keeps each stack’s records apart', () => {
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', undefined);
    resetHermesAgentsStoreForTests();
    setSessionAgentSlug('managed-session', 'researcher');

    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', '/dev/local-assistant');
    resetHermesAgentsStoreForTests();
    expect(getSessionAgentSlug('managed-session')).toBeNull();
    setSessionAgentSlug('local-session', 'designer');

    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', undefined);
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

describe('hermesAgentStore kept writing voices', () => {
  beforeEach(() => resetHermesAgentsStoreForTests());

  it('keeps and clears a chat voice with its marks', () => {
    expect(getSessionWritingVoice('s1')).toBeNull();
    setSessionWritingVoice('s1', 'news');
    expect(getSessionWritingVoice('s1')).toBe('news');
    appendSessionWritingVoiceMark('s1', { kind: 'kept', voiceId: 'news', voiceName: 'News' }, new Date('2026-11-12T10:00:00Z'));
    setSessionWritingVoice('s1', null);
    expect(getSessionWritingVoice('s1')).toBeNull();
    expect(listSessionWritingVoiceMarks('s1')).toEqual([
      { id: expect.any(String), at: '2026-11-12T10:00:00.000Z', kind: 'kept', voiceId: 'news', voiceName: 'News' },
    ]);
  });

  it('moves a kept voice and its marks to a new session id, even with no inference marks', () => {
    setSessionWritingVoice('old', 'news');
    appendSessionWritingVoiceMark('old', { kind: 'kept', voiceId: 'news', voiceName: 'News' });
    migrateSessionInference('old', 'new');
    expect(getSessionWritingVoice('new')).toBe('news');
    expect(listSessionWritingVoiceMarks('new')).toHaveLength(1);
    expect(listSessionWritingVoiceMarks('old')).toEqual([]);
  });

  it('moves a kept voice from a runtime id to the stored id, without overwriting one there', () => {
    setSessionWritingVoice('runtime', 'news');
    appendSessionWritingVoiceMark('runtime', { kind: 'kept', voiceId: 'news', voiceName: 'News' });
    moveSessionWritingVoice('runtime', 'stored');
    expect(getSessionWritingVoice('stored')).toBe('news');
    expect(getSessionWritingVoice('runtime')).toBeNull();
    expect(listSessionWritingVoiceMarks('stored')).toHaveLength(1);
    setSessionWritingVoice('other', 'plain');
    setSessionWritingVoice('stored', 'news');
    moveSessionWritingVoice('other', 'stored');
    expect(getSessionWritingVoice('stored')).toBe('news');
  });
});

describe('hermesAgentStore room voices sent', () => {
  beforeEach(() => resetHermesAgentsStoreForTests());

  it('remembers which voice guide each member was sent in a room', () => {
    expect(getRoomVoiceSent('room-1', 'ana')).toBeNull();
    setRoomVoiceSent('room-1', 'ana', 'news:abc');
    expect(getRoomVoiceSent('room-1', 'ana')).toBe('news:abc');
    expect(getRoomVoiceSent('room-2', 'ana')).toBeNull();
    resetHermesAgentsStoreForTests();
    expect(getRoomVoiceSent('room-1', 'ana')).toBeNull();
  });
});

