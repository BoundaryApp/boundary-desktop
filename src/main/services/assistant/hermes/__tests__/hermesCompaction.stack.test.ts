/**
 * Stack contract: what each history read returns after Hermes compacts a chat. Runs only under
 * `bun run test:stack`.
 *
 * The chat is seeded with numbered turns (no model call), then compacted with
 * `session.compress`, the same routine Hermes runs when a turn nears the context limit. The
 * summary call goes to the stack's compression model, so this file takes minutes, not seconds.
 * The session is stored, so it is deleted afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HermesChatMessage } from '../../../../../shared/types/hermesChat';
import { HermesGatewaySession } from '../hermesGatewaySession';
import type { JsonRpcGatewayClient } from '../vendor';
import { probeStack, skipNote } from '../../__tests__/stackHarness';

const probe = await probeStack();

const TURNS = 16;
const COMPRESS_TIMEOUT_MS = 600_000;
/** Filler so the middle turns are worth compacting: too little and Hermes refuses, because its summary would be larger. Synthetic text only. */
const FILLER = 'The quick brown fox jumps over the lazy dog. '.repeat(25);
const userMarker = (n: number) => `Seed question ${n}`;

function seedTranscript(): HermesChatMessage[] {
  const messages: HermesChatMessage[] = [];
  for (let n = 1; n <= TURNS; n++) {
    messages.push({ role: 'user', content: `${userMarker(n)}. ${FILLER}` } as HermesChatMessage);
    messages.push({ role: 'assistant', content: `Seed answer ${n}. ${FILLER}` } as HermesChatMessage);
  }
  return messages;
}

/** Which seeded user turns a read returned, by number. */
function userTurnsIn(messages: HermesChatMessage[]): number[] {
  const found = new Set<number>();
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    const match = /^Seed question (\d+)\./.exec(m.content);
    if (match) found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

const ALL_TURNS = Array.from({ length: TURNS }, (_, i) => i + 1);

describe.skipIf(!probe.ok)(`Hermes compaction and history reads${skipNote(probe)}`, () => {
  const session = new HermesGatewaySession();
  let client: JsonRpcGatewayClient;
  let runtimeId = '';
  let storedId = '';
  let compressed: { status?: string; before_messages?: number; after_messages?: number; removed?: number } = {};

  beforeAll(async () => {
    client = await session.ensureConnected();
    runtimeId = await session.createSessionWithSeed({
      title: 'Boundary stack test: compaction',
      messages: seedTranscript(),
    });
    storedId = session.storedSessionId(runtimeId);
    // The client's default timeout is shorter than a local model's summary call.
    compressed = (await client.request('session.compress', { session_id: runtimeId }, COMPRESS_TIMEOUT_MS)) as typeof compressed;
  }, COMPRESS_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    try {
      // Hermes refuses to delete an open session.
      if (runtimeId) await client.request('session.close', { session_id: runtimeId }).catch(() => undefined);
      if (storedId) await client.request('session.delete', { session_id: storedId });
    } finally {
      session.dispose();
    }
  });

  it('compacts the seeded chat', () => {
    expect(compressed.status).toBe('compressed');
    expect(compressed.after_messages).toBeLessThan(compressed.before_messages ?? 0);
  });

  it('keeps the stored session id (in-place compaction)', () => {
    expect(session.storedSessionId(runtimeId)).toBe(storedId);
  });

  it('session.resume returns every seeded turn while the session is live', async () => {
    const resumed = await session.resumeSession(storedId);
    expect(userTurnsIn(resumed.messages)).toEqual(ALL_TURNS);
  });

  // session.history reads without include_compacted: the summary's carried-forward head and
  // tail only. Boundary must not show it as the chat's transcript.
  it('session.history drops the compacted middle turns', async () => {
    const history = await session.getSessionHistory(runtimeId);
    const turns = userTurnsIn(history);
    expect(turns).toContain(1);
    expect(turns).toContain(TURNS);
    expect(turns.length).toBeLessThan(TURNS);
  });
});
