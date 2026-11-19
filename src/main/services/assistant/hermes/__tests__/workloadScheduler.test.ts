import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HermesHeldTurn } from '../../../../../shared/types/hermesChat';

const logged = vi.hoisted(() => [] as Array<{ message: string; data: Record<string, unknown> }>);
vi.mock('../../../../persistDebugLog', () => ({
  persistDebugLog: (_area: string, message: string, data: Record<string, unknown> = {}) => {
    logged.push({ message, data });
  },
}));

import {
  heldTurnRequestIds,
  requestTurnSlot,
  resetWorkloadSchedulerForTests,
  runHeldTurnNow,
  type TurnSlot,
} from '../workloadScheduler';

const LM = 'http://127.0.0.1:1234';
const OLLAMA = 'http://127.0.0.1:11434';

function turn(requestId: string, opts: { server?: string; limit?: number } = {}) {
  const controller = new AbortController();
  const held: HermesHeldTurn[] = [];
  let settled: TurnSlot | null = null;
  const slot = requestTurnSlot({
    requestId,
    sessionIds: [`s-${requestId}`, `stored-${requestId}`],
    server: opts.server ?? LM,
    limit: opts.limit ?? 1,
    signal: controller.signal,
    onHeld: (info) => held.push(info),
  }).then((result) => {
    settled = result;
    return result;
  });
  return { controller, held, slot, settled: () => settled };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('workloadScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
    logged.length = 0;
  });
  afterEach(() => {
    resetWorkloadSchedulerForTests();
    vi.useRealTimers();
  });

  it('admits up to the limit and holds the rest in order', async () => {
    const a = turn('a');
    const b = turn('b');
    const c = turn('c');
    await flush();
    expect(a.settled()?.kind).toBe('admitted');
    expect(b.settled()).toBeNull();
    expect(c.settled()).toBeNull();
    expect(b.held.at(-1)).toEqual({ position: 1, ahead: 1, limit: 1, runningSessionIds: ['s-a'] });
    expect(c.held.at(-1)).toEqual({ position: 2, ahead: 2, limit: 1, runningSessionIds: ['s-a'] });
    expect(heldTurnRequestIds()).toEqual(['b', 'c']);

    vi.advanceTimersByTime(4_000);
    const slotA = await a.slot;
    if (slotA.kind === 'admitted') slotA.release();
    await flush();
    const slotB = await b.slot;
    expect(slotB).toMatchObject({ kind: 'admitted', waitedMs: 4_000 });
    expect(c.settled()).toBeNull();
    expect(c.held.at(-1)).toEqual({ position: 1, ahead: 1, limit: 1, runningSessionIds: ['s-b'] });

    if (slotB.kind === 'admitted') slotB.release();
    expect((await c.slot).kind).toBe('admitted');
  });

  it('releases a slot once, whether the turn succeeded or failed', async () => {
    const a = turn('a');
    const b = turn('b');
    const c = turn('c');
    const slotA = await a.slot;
    if (slotA.kind !== 'admitted') throw new Error('expected admitted');
    slotA.release();
    slotA.release();
    await flush();
    expect(b.settled()?.kind).toBe('admitted');
    expect(c.settled()).toBeNull();
  });

  it('withdraws a held turn when it is stopped, and moves the next one up', async () => {
    const a = turn('a');
    const b = turn('b');
    const c = turn('c');
    await flush();
    b.controller.abort('stopped');
    expect(await b.slot).toMatchObject({ kind: 'withdrawn', reason: 'stopped' });
    expect(c.held.at(-1)).toMatchObject({ position: 1, ahead: 1 });
    expect(heldTurnRequestIds()).toEqual(['c']);
    // Stopping the held turn never touches the running one.
    expect(a.settled()?.kind).toBe('admitted');
    expect(logged.map((l) => l.message)).toEqual(['turn admitted', 'turn held', 'turn held', 'turn withdrawn']);
  });

  it('withdraws a turn whose signal was aborted before it asked', async () => {
    const controller = new AbortController();
    controller.abort('stopped');
    const slot = await requestTurnSlot({ requestId: 'x', sessionIds: ['s'], server: LM, limit: 1, signal: controller.signal });
    expect(slot.kind).toBe('withdrawn');
  });

  it('Run now admits a held turn over the limit', async () => {
    const a = turn('a');
    const b = turn('b');
    const c = turn('c');
    await flush();
    expect(runHeldTurnNow('c')).toBe(true);
    expect((await c.slot).kind).toBe('admitted');
    expect(b.held.at(-1)).toEqual({ position: 1, ahead: 2, limit: 1, runningSessionIds: ['s-a', 's-c'] });
    expect(runHeldTurnNow('c')).toBe(false);
    expect(a.settled()?.kind).toBe('admitted');
    expect(logged.find((l) => l.message === 'turn admitted' && l.data.requestId === 'c')?.data.how).toBe('run-now');
  });

  it('a slot freed while over the limit admits nobody until the server is under it', async () => {
    const a = turn('a');
    turn('b');
    const c = turn('c');
    await flush();
    runHeldTurnNow('b');
    const slotA = await a.slot;
    if (slotA.kind === 'admitted') slotA.release();
    await flush();
    // b still runs, at the limit of 1, so c keeps waiting.
    expect(c.settled()).toBeNull();
  });

  it('counts servers apart', async () => {
    const a = turn('a', { server: LM });
    const b = turn('b', { server: OLLAMA });
    await flush();
    expect(a.settled()?.kind).toBe('admitted');
    expect(b.settled()?.kind).toBe('admitted');
  });

  it('runs as many turns as the limit allows', async () => {
    const a = turn('a', { limit: 2 });
    const b = turn('b', { limit: 2 });
    const c = turn('c', { limit: 2 });
    await flush();
    expect(a.settled()?.kind).toBe('admitted');
    expect(b.settled()?.kind).toBe('admitted');
    expect(c.held.at(-1)).toEqual({ position: 1, ahead: 2, limit: 2, runningSessionIds: ['s-a', 's-b'] });
  });

  it('logs ids, the server and times only', async () => {
    turn('a');
    turn('b');
    await flush();
    const held = logged.find((l) => l.message === 'turn held');
    expect(held?.data).toEqual({ requestId: 'b', sessionId: 's-b', server: LM, limit: 1, running: 1, position: 1 });
    expect(logged[0].data).toEqual({
      requestId: 'a',
      sessionId: 's-a',
      server: LM,
      limit: 1,
      running: 1,
      waitedMs: 0,
      how: 'free',
    });
  });
});
