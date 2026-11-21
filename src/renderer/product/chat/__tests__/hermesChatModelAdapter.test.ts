import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ChatModelRunResult,
  RunConfig,
} from '@assistant-ui/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ElectronAPI } from '../../../../preload';
import type { HermesChatToolEvent } from '../../../../shared/types/hermesChat';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import {
  CONTINUE_LATEST_ONLY_MESSAGE,
  CONTINUE_RUN_CONFIG,
  createHermesChatModelAdapter,
  DIVERGED_MESSAGE,
  type InferenceSendHandlers,
} from '../hermesChatModelAdapter';
import { ServerPath } from '../serverPath';
import { isOwnedRunningTurn } from '../runningTurns';

type HermesChatAPI = ElectronAPI['hermesChat'];
const startChat = vi.fn<HermesChatAPI['startChat']>();
const cancelChat = vi.fn<HermesChatAPI['cancelChat']>();
const onChatChunk = vi.fn<HermesChatAPI['onChatChunk']>();
const onChatEnd = vi.fn<HermesChatAPI['onChatEnd']>();
const onChatError = vi.fn<HermesChatAPI['onChatError']>();
const onChatTool = vi.fn<HermesChatAPI['onChatTool']>(() => () => undefined);
const onChatSpeaker = vi.fn<HermesChatAPI['onChatSpeaker']>(() => () => undefined);

stubElectronAPI({
  hermesChat: {
    startChat: (...args: Parameters<HermesChatAPI['startChat']>) => startChat(...args),
    cancelChat: (...args: Parameters<HermesChatAPI['cancelChat']>) => cancelChat(...args),
    onChatChunk: (...args: Parameters<HermesChatAPI['onChatChunk']>) => onChatChunk(...args),
    onChatEnd: (...args: Parameters<HermesChatAPI['onChatEnd']>) => onChatEnd(...args),
    onChatError: (...args: Parameters<HermesChatAPI['onChatError']>) => onChatError(...args),
    onChatTool: (...args: Parameters<HermesChatAPI['onChatTool']>) => onChatTool(...args),
    onChatSpeaker: (...args: Parameters<HermesChatAPI['onChatSpeaker']>) => onChatSpeaker(...args),
  },
});

/**
 * Runs a turn the way useLocalRuntime does, which always passes a run config. The adapter's
 * `run` is an async generator.
 */
function runTurn(
  adapter: ChatModelAdapter,
  options: Pick<ChatModelRunOptions, 'messages' | 'abortSignal' | 'unstable_assistantMessageId'> & {
    runConfig?: RunConfig;
  }
): AsyncGenerator<ChatModelRunResult, void> {
  return adapter.run({
    runConfig: {},
    context: {},
    unstable_getMessage: () => {
      throw new Error('the adapter does not read the message');
    },
    ...options,
  }) as AsyncGenerator<ChatModelRunResult, void>;
}

// clearAllMocks keeps implementations, so each test starts from these defaults rather than
// whatever listener or start reply the previous test installed.
beforeEach(() => {
  for (const mock of [startChat, cancelChat, onChatChunk, onChatEnd, onChatError, onChatTool]) {
    mock.mockReset();
  }
  onChatChunk.mockImplementation(() => () => undefined);
  onChatEnd.mockImplementation(() => () => undefined);
  onChatError.mockImplementation(() => () => undefined);
  onChatTool.mockImplementation(() => () => undefined);
});

/** The adapter makes the turn's request id; tests pick it so their events match. */
function useRequestId(id: string): void {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(id as ReturnType<typeof crypto.randomUUID>);
}

/** The screen's send handlers, doing nothing unless the test gives one. */
function sendHandlers(given: Partial<InferenceSendHandlers>): InferenceSendHandlers {
  return {
    onLocalUnreachable: () => undefined,
    onPrivateRefused: () => undefined,
    takeNewChatInference: () => null,
    takeNewChatWritingVoice: () => null,
    ...given,
  };
}

describe('createHermesChatModelAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('yields cumulative text from IPC chunks then finishes', async () => {
    let chunkCb: ((e: { requestId: string; delta: string }) => void) | null = null;
    let endCb: ((e: { requestId: string }) => void) | null = null;

    onChatChunk.mockImplementation((cb) => {
      chunkCb = cb;
      return () => undefined;
    });
    onChatEnd.mockImplementation((cb) => {
      endCb = cb;
      return () => undefined;
    });
    onChatError.mockImplementation(() => () => undefined);

    useRequestId('req-1');
    startChat.mockResolvedValue({ success: true, requestId: 'req-1', sessionId: 'session-1' });

    const adapter = createHermesChatModelAdapter(() => 'session-1');
    const abort = new AbortController();
    const gen = runTurn(adapter, {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hi' }],
        } as never,
      ],
      abortSignal: abort.signal,
    });

    const yields: string[] = [];
    const consume = (async () => {
      for await (const update of gen) {
        const text = update.content
          ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('');
        if (text) yields.push(text);
      }
    })();

    // Allow startChat + subscriptions to register
    await Promise.resolve();
    await Promise.resolve();

    chunkCb?.({ requestId: 'req-1', delta: 'Hel' });
    await Promise.resolve();
    chunkCb?.({ requestId: 'req-1', delta: 'lo' });
    await Promise.resolve();
    endCb?.({ requestId: 'req-1' });
    await consume;

    expect(startChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        toolsEnabled: true,
      })
    );
    expect(yields.at(-1)).toBe('Hello');
  });

  it("puts each room speaker's writing voice on its section, or on the reply when one spoke", async () => {
    type Cb<T> = ((e: T) => void) | null;
    let chunkCb: Cb<{ requestId: string; delta: string; agentSlug?: string }> = null;
    let speakerCb: Cb<{ requestId: string; agentSlug: string; writingVoiceName?: string }> = null;
    let endCb: Cb<{ requestId: string }> = null;
    onChatChunk.mockImplementation((cb) => ((chunkCb = cb), () => undefined));
    onChatSpeaker.mockImplementation((cb) => ((speakerCb = cb), () => undefined));
    onChatEnd.mockImplementation((cb) => ((endCb = cb), () => undefined));
    onChatError.mockImplementation(() => () => undefined);
    const wake = async (speakers: Array<[string, string | undefined, string]>) => {
      useRequestId('req-voices');
      startChat.mockResolvedValue({ success: true, requestId: 'req-voices', sessionId: 'chan-1' });
      const gen = runTurn(createHermesChatModelAdapter(() => 'chan-1'), {
        messages: [{ role: 'user', content: [{ type: 'text', text: '@Ana look' }] } as never],
        abortSignal: new AbortController().signal,
      });
      let last: Record<string, unknown> | undefined;
      const consume = (async () => {
        for await (const update of gen) last = update.metadata?.custom;
      })();
      await Promise.resolve();
      await Promise.resolve();
      for (const [slug, voice, delta] of speakers) {
        speakerCb?.({ requestId: 'req-voices', agentSlug: slug, ...(voice ? { writingVoiceName: voice } : {}) });
        chunkCb?.({ requestId: 'req-voices', delta, agentSlug: slug });
        await Promise.resolve();
      }
      endCb?.({ requestId: 'req-voices' });
      await consume;
      return last;
    };
    expect(await wake([['ana', 'News', 'Two vendors.'], ['assistant', undefined, 'Confirmed.']])).toMatchObject({
      segments: [
        { agentSlug: 'ana', text: 'Two vendors.', writingVoiceName: 'News' },
        { agentSlug: 'assistant', text: 'Confirmed.' },
      ],
    });
    expect(await wake([['ana', 'News', 'Alone.']])).toMatchObject({ agentSlug: 'ana', writingVoiceName: 'News' });
  });

  it('gives each speaker in a room wake its own section (ADR 0010 §1)', async () => {
    let chunkCb: ((e: { requestId: string; delta: string; agentSlug?: string }) => void) | null =
      null;
    let endCb: ((e: { requestId: string }) => void) | null = null;
    onChatChunk.mockImplementation((cb) => {
      chunkCb = cb;
      return () => undefined;
    });
    onChatEnd.mockImplementation((cb) => {
      endCb = cb;
      return () => undefined;
    });
    onChatError.mockImplementation(() => () => undefined);
    useRequestId('req-room');
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-room',
      sessionId: 'chan-1',
    });

    const adapter = createHermesChatModelAdapter(() => 'chan-1');
    const gen = runTurn(adapter, {
      messages: [{ role: 'user', content: [{ type: 'text', text: '@Ana look' }] } as never],
      abortSignal: new AbortController().signal,
    });
    const updates: Array<{ text?: string; custom?: Record<string, unknown> }> = [];
    const consume = (async () => {
      for await (const update of gen) {
        const part = update.content?.[0];
        updates.push({
          text: part && part.type === 'text' ? part.text : undefined,
          custom: update.metadata?.custom,
        });
      }
    })();
    await Promise.resolve();
    await Promise.resolve();

    chunkCb?.({ requestId: 'req-room', delta: 'Two vendors.', agentSlug: 'ana' });
    await Promise.resolve();
    chunkCb?.({ requestId: 'req-room', delta: 'Confirmed.', agentSlug: 'assistant' });
    await Promise.resolve();
    endCb?.({ requestId: 'req-room' });
    await consume;

    expect(updates[0]).toEqual({ text: 'Two vendors.', custom: { agentSlug: 'ana' } });
    expect(updates.at(-1)).toEqual({
      text: 'Two vendors.\n\nConfirmed.',
      custom: expect.objectContaining({
        agentSlug: 'ana',
        segments: [
          { agentSlug: 'ana', text: 'Two vendors.' },
          { agentSlug: 'assistant', text: 'Confirmed.' },
        ],
      }),
    });
  });

  describe('the time main saw the turn finish, for the reply’s pool line', () => {
    async function turn(stop: boolean): Promise<ChatModelRunResult[]> {
      let chunkCb: ((e: { requestId: string; delta: string }) => void) | null = null;
      let endCb: ((e: { requestId: string; endedAt?: number }) => void) | null = null;
      onChatChunk.mockImplementation((cb) => {
        chunkCb = cb;
        return () => undefined;
      });
      onChatEnd.mockImplementation((cb) => {
        endCb = cb;
        return () => undefined;
      });
      useRequestId('req-end');
      startChat.mockResolvedValue({ success: true, requestId: 'req-end', sessionId: 's1' });
      cancelChat.mockResolvedValue({ success: true });
      const abort = new AbortController();
      const gen = runTurn(createHermesChatModelAdapter(() => 's1'), {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] } as never],
        abortSignal: abort.signal,
      });
      const yields: ChatModelRunResult[] = [];
      const consume = (async () => {
        for await (const update of gen) yields.push(update);
      })();
      await Promise.resolve();
      await Promise.resolve();
      chunkCb?.({ requestId: 'req-end', delta: 'Hello' });
      await Promise.resolve();
      if (stop) abort.abort();
      else endCb?.({ requestId: 'req-end', endedAt: 1_700_000_000_000 });
      await consume;
      return yields;
    }

    it('is on the final reply of a finished turn', async () => {
      const yields = await turn(false);
      expect(yields.at(-1)?.metadata?.custom?.turnEndedAt).toBe(1_700_000_000_000);
      expect(yields.slice(0, -1).some((y) => y.metadata?.custom?.turnEndedAt !== undefined)).toBe(false);
    });

    it('is on no reply of a stopped turn', async () => {
      const yields = await turn(true);
      expect(yields.length).toBeGreaterThan(0);
      expect(yields.some((y) => y.metadata?.custom?.turnEndedAt !== undefined)).toBe(false);
    });
  });

  it('cancels chat when abortSignal fires', async () => {
    onChatChunk.mockImplementation(() => () => undefined);
    onChatEnd.mockImplementation(() => () => undefined);
    onChatError.mockImplementation(() => () => undefined);
    useRequestId('req-abort');
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-abort',
      sessionId: 's1',
    });
    cancelChat.mockResolvedValue({ success: true });

    const adapter = createHermesChatModelAdapter(() => 's1');
    const abort = new AbortController();
    const gen = runTurn(adapter, {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Stop me' }],
        } as never,
      ],
      abortSignal: abort.signal,
    });

    const consume = (async () => {
      for await (const _ of gen) {
        /* drain */
      }
    })();

    await Promise.resolve();
    await Promise.resolve();
    abort.abort();
    await consume;

    expect(cancelChat).toHaveBeenCalledWith({ requestId: 'req-abort', reason: 'stopped', via: 'stop' });
    // This screen keeps showing the stopped turn, so its end never triggers a reload.
    expect(isOwnedRunningTurn('req-abort')).toBe(true);
  });

  it('leaves the Hermes turn running when the runtime detaches', async () => {
    onChatChunk.mockImplementation(() => () => undefined);
    onChatEnd.mockImplementation(() => () => undefined);
    onChatError.mockImplementation(() => () => undefined);
    useRequestId('req-detach');
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-detach',
      sessionId: 's1',
    });

    const adapter = createHermesChatModelAdapter(() => 's1');
    const abort = new AbortController();
    const gen = runTurn(adapter, {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Keep going while I look elsewhere' }],
        } as never,
      ],
      abortSignal: abort.signal,
    });

    const consume = (async () => {
      for await (const _ of gen) {
        /* drain */
      }
    })();

    await Promise.resolve();
    await Promise.resolve();
    // What useLocalRuntime's unmount does (assistant-ui AbortError with detach: true).
    abort.abort(Object.assign(new Error('detached'), { detach: true }));
    await consume;

    expect(cancelChat).not.toHaveBeenCalled();
    // Whichever screen shows the chat next reloads it when the turn ends.
    expect(isOwnedRunningTurn('req-detach')).toBe(false);
  });

  it('notifies when start returns a reminted session id', async () => {
    onChatChunk.mockImplementation(() => () => undefined);
    onChatEnd.mockImplementation((cb) => {
      queueMicrotask(() => cb({ requestId: 'req-2' }));
      return () => undefined;
    });
    onChatError.mockImplementation(() => () => undefined);
    useRequestId('req-2');
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-2',
      sessionId: 'gateway-session',
      storedSessionId: 'stored-session',
    });

    const onResolved = vi.fn();
    const adapter = createHermesChatModelAdapter(() => 'local-uuid', {
      onSessionResolved: onResolved,
    });
    const abort = new AbortController();
    const gen = runTurn(adapter, {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hi' }],
        } as never,
      ],
      abortSignal: abort.signal,
    });

    for await (const _ of gen) {
      /* drain */
    }

    expect(onResolved).toHaveBeenCalledWith('gateway-session', 'stored-session');
  });

  it("sends a message's voice and a new chat's kept voice, and marks the reply", async () => {
    onChatChunk.mockImplementation(() => () => undefined);
    onChatEnd.mockImplementation((cb) => {
      queueMicrotask(() => cb({ requestId: 'req-voice' }));
      return () => undefined;
    });
    onChatError.mockImplementation(() => () => undefined);
    useRequestId('req-voice');
    startChat.mockResolvedValue({ success: true, requestId: 'req-voice', sessionId: 's9', writingVoiceName: 'News' });
    const adapter = createHermesChatModelAdapter(() => null, {
      getSendHandlers: () => sendHandlers({ takeNewChatWritingVoice: () => 'plain' }),
    });
    const results: ChatModelRunResult[] = [];
    for await (const r of runTurn(adapter, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] } as never],
      abortSignal: new AbortController().signal,
      runConfig: { custom: { writingVoiceId: 'news' } },
    })) {
      results.push(r);
    }
    expect(startChat).toHaveBeenCalledWith(
      expect.objectContaining({ writingVoiceId: 'news', keptWritingVoiceId: 'plain' })
    );
    expect(results.at(-1)?.metadata?.custom).toMatchObject({ writingVoiceName: 'News' });
  });

  it('passes toolsEnabled false from getter', async () => {
    onChatChunk.mockImplementation(() => () => undefined);
    onChatEnd.mockImplementation((cb) => {
      queueMicrotask(() => cb({ requestId: 'req-tools' }));
      return () => undefined;
    });
    onChatError.mockImplementation(() => () => undefined);
    useRequestId('req-tools');
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-tools',
      sessionId: 's1',
    });

    const adapter = createHermesChatModelAdapter(() => 's1', {
      getToolsEnabled: () => false,
    });
    const abort = new AbortController();
    const gen = runTurn(adapter, {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'No tools' }],
        } as never,
      ],
      abortSignal: abort.signal,
    });

    for await (const _ of gen) {
      /* drain */
    }

    expect(startChat).toHaveBeenCalledWith(
      expect.objectContaining({ toolsEnabled: false })
    );
  });

  it('yields only a room-post marker when start reports a channel post', async () => {
    const unsubChunk = vi.fn();
    const unsubEnd = vi.fn();
    onChatChunk.mockImplementation(() => unsubChunk);
    onChatEnd.mockImplementation(() => unsubEnd);
    onChatError.mockImplementation(() => () => undefined);
    useRequestId('req-post');
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-post',
      sessionId: 'chan-1',
      posted: true,
    });

    const adapter = createHermesChatModelAdapter(() => 'chan-1');
    const abort = new AbortController();
    const gen = runTurn(adapter, {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'posted to the room' }],
        } as never,
      ],
      abortSignal: abort.signal,
    });

    const yields: unknown[] = [];
    for await (const update of gen) {
      yields.push(update);
    }

    expect(yields).toEqual([{ content: [], metadata: { custom: { roomPost: true } } }]);
    // Listening started before the start reply; a post stops it and leaves the turn unowned.
    expect(unsubChunk).toHaveBeenCalled();
    expect(unsubEnd).toHaveBeenCalled();
    expect(isOwnedRunningTurn('req-post')).toBe(false);
  });

  it('hands a privacy refusal to the chat instead of throwing', async () => {
    const onPrivateRefused = vi.fn();
    useRequestId('req-private');
    startChat.mockResolvedValue({
      success: false,
      requestId: 'req-private',
      sessionId: 's1',
      errorCode: 'private-refused',
      error: 'This project is private and this chat’s model isn’t, so your message wasn’t sent.',
    });
    const adapter = createHermesChatModelAdapter(() => 's1', {
      getSendHandlers: () => sendHandlers({ onPrivateRefused }),
    });
    const gen = runTurn(adapter, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as never],
      abortSignal: new AbortController().signal,
    });
    await expect(gen.next()).resolves.toMatchObject({ done: true });
    expect(onPrivateRefused).toHaveBeenCalled();
  });

  it('adds a transcript note when a shared model is unavailable too', async () => {
    const onLocalUnreachable = vi.fn();
    useRequestId('req-both');
    const error = 'Your shared model isn’t available and your local model didn’t answer, so your message wasn’t sent.';
    startChat.mockResolvedValue({
      success: false,
      requestId: 'req-both',
      errorCode: 'local-unreachable',
      sharedUnavailable: true,
      error,
    });

    const adapter = createHermesChatModelAdapter(() => 's1', {
      getSendHandlers: () => sendHandlers({ onLocalUnreachable }),
    });
    const gen = runTurn(adapter, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as never],
      abortSignal: new AbortController().signal,
    });
    expect(((await gen.next()).value as ChatModelRunResult | undefined)?.metadata?.custom).toEqual({ noReply: { reason: 'unreachable', error } });
    expect((await gen.next()).done).toBe(true);
    expect(onLocalUnreachable).toHaveBeenCalledOnce();
  });

  it('puts a refused shared model in the transcript, not an empty reply', async () => {
    useRequestId('req-refused');
    const error = 'Ada’s qwen3:14b is offline. Your message wasn’t sent.';
    startChat.mockResolvedValue({ success: false, requestId: 'req-refused', errorCode: 'apply-failed', error });

    const gen = runTurn(createHermesChatModelAdapter(() => 's1'), {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as never],
      abortSignal: new AbortController().signal,
    });
    expect(((await gen.next()).value as ChatModelRunResult | undefined)?.metadata?.custom).toEqual({ noReply: { reason: 'unreachable', error } });
    expect((await gen.next()).done).toBe(true);
  });

  it('does not throw a generic error when start reports local-unreachable', async () => {
    const onLocalUnreachable = vi.fn();
    useRequestId('req-offline');
    startChat.mockResolvedValue({
      success: false,
      requestId: 'req-offline',
      sessionId: 's1',
      errorCode: 'local-unreachable',
      error: 'Local model unreachable. Retry, or send this message via OpenRouter.',
    });

    const adapter = createHermesChatModelAdapter(() => 's1', {
      getSendHandlers: () => sendHandlers({ onLocalUnreachable }),
    });
    const abort = new AbortController();
    const gen = runTurn(adapter, {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        } as never,
      ],
      abortSignal: abort.signal,
    });

    const yields: unknown[] = [];
    for await (const update of gen) {
      yields.push(update);
    }

    expect(yields).toEqual([]);
    expect(onLocalUnreachable).toHaveBeenCalled();
    expect(isOwnedRunningTurn('req-offline')).toBe(false);
  });
});

describe('createHermesChatModelAdapter server path', () => {
  const user = (id: string, text: string) =>
    ({ id, role: 'user', content: [{ type: 'text', text }] }) as never;
  const run = (
    adapter: ReturnType<typeof createHermesChatModelAdapter>,
    messages: never[],
    assistantId: string
  ) =>
    runTurn(adapter, {
      messages,
      abortSignal: new AbortController().signal,
      unstable_assistantMessageId: assistantId,
    });
  const drain = async (gen: AsyncGenerator<unknown> | Promise<unknown>) => {
    try {
      for await (const _ of gen as AsyncGenerator<unknown>) {
        /* drain */
      }
    } catch {
      /* the run's error is the runtime's to show */
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    onChatChunk.mockImplementation(() => () => undefined);
    onChatError.mockImplementation(() => () => undefined);
  });

  it('refuses to continue an older version without calling main', async () => {
    const path = new ServerPath([
      { id: 'u1', role: 'user', text: 'a', rowId: 1 },
      { id: 'a1', role: 'assistant', text: 'b', rowId: 2 },
    ]);
    const adapter = createHermesChatModelAdapter(() => 's1', { getServerPath: () => path });
    const gen = run(
      adapter,
      [user('u1', 'a'), { id: 'a1-old', role: 'assistant', content: [] } as never, user('u2', 'c')],
      'a2'
    );
    await expect((gen as AsyncGenerator<unknown>).next()).rejects.toThrow(DIVERGED_MESSAGE);
    expect(startChat).not.toHaveBeenCalled();
  });

  it('keeps the chat usable after a send that failed before Hermes took it', async () => {
    const path = new ServerPath();
    const adapter = createHermesChatModelAdapter(() => 's1', { getServerPath: () => path });
    useRequestId('req-fail');
    startChat.mockResolvedValueOnce({
      success: false,
      requestId: 'req-fail',
      errorCode: 'rewind-stale',
      error: 'stale',
    });
    await drain(run(adapter, [user('u1', 'hello')], 'a1'));

    // The runtime shows the failed turn, so the server path follows it and the next
    // send still extends the chat instead of being mistaken for an older version.
    expect(path.messageIds()).toEqual(['u1', 'a1']);
    expect(
      path.plan([
        { id: 'u1', role: 'user', text: 'hello', rowId: null },
        { id: 'a1', role: 'assistant', text: '', rowId: null },
        { id: 'u2', role: 'user', text: 'again', rowId: null },
      ])
    ).toEqual({ kind: 'append' });
  });

  it('records the files this turn wrote on the reply', async () => {
    const tools: Array<(e: HermesChatToolEvent) => void> = [];
    onChatTool.mockImplementation((cb) => {
      tools.push(cb);
      return () => undefined;
    });
    onChatEnd.mockImplementation((cb) => {
      queueMicrotask(() => {
        const done = (name: string, path: string, requestId = 'req-files') =>
          tools.forEach((t) =>
            t({ requestId, toolId: name + path, name, status: 'done', args: { path } })
          );
        done('write_file', '/opt/projects/p/a.md');
        done('read_file', '/opt/projects/p/notes.md');
        done('patch', '/opt/projects/p/a.md');
        done('write_file', '/opt/projects/p/other-turn.md', 'req-other');
        cb({ requestId: 'req-files' });
      });
      return () => undefined;
    });
    useRequestId('req-files');
    startChat.mockResolvedValueOnce({
      success: true,
      requestId: 'req-files',
      sessionId: 's1',
    });
    const adapter = createHermesChatModelAdapter(() => 's1');
    const updates: Array<{ metadata?: { custom?: Record<string, unknown> } }> = [];
    for await (const update of run(adapter, [user('u1', 'write it')], 'a1') as AsyncGenerator<
      (typeof updates)[number]
    >) {
      updates.push(update);
    }
    expect(updates.at(-1)?.metadata?.custom?.files).toEqual(['/opt/projects/p/a.md']);
    // Three distinct tools ran in this turn (the other request's call does not count).
    expect(updates.at(-1)?.metadata?.custom?.toolCount).toBe(3);
  });
});

describe('createHermesChatModelAdapter Continue (run control)', () => {
  const user = (id: string, text: string) =>
    ({ id, role: 'user', content: [{ type: 'text', text }] }) as never;
  const reply = (id: string, text: string) =>
    ({ id, role: 'assistant', content: [{ type: 'text', text }] }) as never;
  const run = (
    adapter: ReturnType<typeof createHermesChatModelAdapter>,
    messages: never[],
    assistantId: string,
    runConfig?: RunConfig
  ) =>
    runTurn(adapter, {
      messages,
      abortSignal: new AbortController().signal,
      unstable_assistantMessageId: assistantId,
      ...(runConfig ? { runConfig } : {}),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    onChatChunk.mockImplementation(() => () => undefined);
    onChatError.mockImplementation(() => () => undefined);
    onChatEnd.mockImplementation((cb) => {
      queueMicrotask(() => cb({ requestId: 'req-cont' }));
      return () => undefined;
    });
    useRequestId('req-cont');
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-cont',
      sessionId: 's1',
    });
  });

  it('asks main to continue the stopped reply, and the new reply joins the path', async () => {
    const path = new ServerPath([
      { id: 'u1', role: 'user', text: 'write it', rowId: 1 },
      { id: 'a1', role: 'assistant', text: 'Dear Sam', rowId: null },
    ]);
    const adapter = createHermesChatModelAdapter(() => 's1', { getServerPath: () => path });

    for await (const _ of run(
      adapter,
      [user('u1', 'write it'), reply('a1', 'Dear Sam')],
      'a2',
      CONTINUE_RUN_CONFIG
    ) as AsyncGenerator<unknown>) {
      /* drain */
    }

    expect(startChat).toHaveBeenCalledWith(expect.objectContaining({ continue: true }));
    expect(startChat.mock.calls[0]![0]).not.toHaveProperty('rewind');
    expect(path.messageIds()).toEqual(['u1', 'a1', 'a2']);
  });

  it('refuses to continue a reply that is no longer the latest', async () => {
    const path = new ServerPath([
      { id: 'u1', role: 'user', text: 'a', rowId: 1 },
      { id: 'a1', role: 'assistant', text: 'b', rowId: 2 },
      { id: 'u2', role: 'user', text: 'c', rowId: 3 },
      { id: 'a2', role: 'assistant', text: 'd', rowId: 4 },
    ]);
    const adapter = createHermesChatModelAdapter(() => 's1', { getServerPath: () => path });
    const gen = run(adapter, [user('u1', 'a'), reply('a1', 'b')], 'a3', CONTINUE_RUN_CONFIG);
    await expect((gen as AsyncGenerator<unknown>).next()).rejects.toThrow(
      CONTINUE_LATEST_ONLY_MESSAGE
    );
    expect(startChat).not.toHaveBeenCalled();
  });

  it('owns and hears its turn before startChat replies, with the request id it sent', async () => {
    let chunkCb: ((e: { requestId: string; delta: string }) => void) | null = null;
    let endCb: ((e: { requestId: string }) => void) | null = null;
    onChatChunk.mockImplementation((cb) => {
      chunkCb = cb;
      return () => undefined;
    });
    onChatEnd.mockImplementation((cb) => {
      endCb = cb;
      return () => undefined;
    });
    onChatError.mockImplementation(() => () => undefined);
    useRequestId('req-early');
    let ownedAtStart = false;
    startChat.mockImplementation(async (payload: { requestId?: string }) => {
      // Main sends events for the request while the start handler is still running.
      ownedAtStart = isOwnedRunningTurn(payload.requestId ?? '');
      chunkCb?.({ requestId: payload.requestId ?? '', delta: 'Early' });
      endCb?.({ requestId: payload.requestId ?? '' });
      return { success: true, requestId: payload.requestId, sessionId: 's1' };
    });

    const adapter = createHermesChatModelAdapter(() => 's1');
    const gen = runTurn(adapter, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] } as never],
      abortSignal: new AbortController().signal,
    });
    const yields: string[] = [];
    for await (const update of gen) {
      const text = update.content
        ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
      if (text) yields.push(text);
    }

    expect(startChat).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-early' }));
    expect(ownedAtStart).toBe(true);
    expect(yields.at(-1)).toBe('Early');
  });
});

describe('filed task cards from live tool results (new-C-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runWithTool(event: Partial<HermesChatToolEvent>) {
    let toolCb: ((e: HermesChatToolEvent) => void) | null = null;
    let endCb: ((e: { requestId: string }) => void) | null = null;
    onChatTool.mockImplementation((cb) => {
      toolCb = cb;
      return () => undefined;
    });
    onChatChunk.mockImplementation(() => () => undefined);
    onChatEnd.mockImplementation((cb) => {
      endCb = cb;
      return () => undefined;
    });
    onChatError.mockImplementation(() => () => undefined);
    useRequestId('req-kanban');
    startChat.mockResolvedValue({ success: true, requestId: 'req-kanban', sessionId: 's1' });

    const adapter = createHermesChatModelAdapter(() => 's1');
    const gen = runTurn(adapter, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'file it' }] } as never],
      abortSignal: new AbortController().signal,
    });
    const updates: Array<{ metadata?: { custom?: Record<string, unknown> } }> = [];
    const consume = (async () => {
      for await (const update of gen) updates.push(update as never);
    })();
    await Promise.resolve();
    await Promise.resolve();
    toolCb!({ requestId: 'req-kanban', toolId: 't1', name: 'kanban_create', status: 'done', args: { title: 'T' }, ...event });
    endCb!({ requestId: 'req-kanban' });
    await consume;
    return updates.at(-1)?.metadata?.custom?.tasksFiled;
  }

  it('does not file a refused kanban_create whose summary is prose', async () => {
    const filed = await runWithTool({
      summary: 'Tried to file the task.',
      result: '{"ok": false, "error": "assignee unknown"}',
    });
    expect(filed).toBeUndefined();
  });

  it('files an accepted kanban_create with its task id', async () => {
    const filed = await runWithTool({
      summary: 'Filed the task.',
      result: '{"ok": true, "task_id": "t_9"}',
    });
    expect(filed).toEqual([{ title: 'T', assignee: null, taskId: 't_9' }]);
  });
});
