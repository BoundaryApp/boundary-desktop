import { describe, expect, it, vi, beforeEach } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import {
  CONTINUE_LATEST_ONLY_MESSAGE,
  CONTINUE_RUN_CONFIG,
  createHermesChatModelAdapter,
  DIVERGED_MESSAGE,
} from '../hermesChatModelAdapter';
import { ServerPath } from '../serverPath';
import { isOwnedRunningTurn } from '../runningTurns';

const startChat = vi.fn();
const cancelChat = vi.fn();
const onChatChunk = vi.fn();
const onChatEnd = vi.fn();
const onChatError = vi.fn();
const onChatTool = vi.fn(() => () => undefined);

stubElectronAPI({
  hermesChat: {
    startChat: (...args: unknown[]) => startChat(...args),
    cancelChat: (...args: unknown[]) => cancelChat(...args),
    onChatChunk: (...args: unknown[]) => onChatChunk(...args),
    onChatEnd: (...args: unknown[]) => onChatEnd(...args),
    onChatError: (...args: unknown[]) => onChatError(...args),
    onChatTool: (...args: unknown[]) => onChatTool(...args),
  },
});

/** The adapter makes the turn's request id; tests pick it so their events match. */
function useRequestId(id: string): void {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(id as ReturnType<typeof crypto.randomUUID>);
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
    const gen = adapter.run({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hi' }],
        } as never,
      ],
      abortSignal: abort.signal,
      context: {} as never,
      unstable_getMessage: (() => undefined) as never,
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
    const gen = adapter.run({
      messages: [{ role: 'user', content: [{ type: 'text', text: '@Ana look' }] } as never],
      abortSignal: new AbortController().signal,
      context: {} as never,
      unstable_getMessage: (() => undefined) as never,
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
    const gen = adapter.run({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Stop me' }],
        } as never,
      ],
      abortSignal: abort.signal,
      context: {} as never,
      unstable_getMessage: (() => undefined) as never,
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

    expect(cancelChat).toHaveBeenCalledWith({ requestId: 'req-abort', reason: 'stopped' });
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
    const gen = adapter.run({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Keep going while I look elsewhere' }],
        } as never,
      ],
      abortSignal: abort.signal,
      context: {} as never,
      unstable_getMessage: (() => undefined) as never,
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
    });

    const onResolved = vi.fn();
    const adapter = createHermesChatModelAdapter(() => 'local-uuid', {
      onSessionResolved: onResolved,
    });
    const abort = new AbortController();
    const gen = adapter.run({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hi' }],
        } as never,
      ],
      abortSignal: abort.signal,
      context: {} as never,
      unstable_getMessage: (() => undefined) as never,
    });

    for await (const _ of gen) {
      /* drain */
    }

    expect(onResolved).toHaveBeenCalledWith('gateway-session');
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
    const gen = adapter.run({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'No tools' }],
        } as never,
      ],
      abortSignal: abort.signal,
      context: {} as never,
      unstable_getMessage: (() => undefined) as never,
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
    const gen = adapter.run({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'posted to the room' }],
        } as never,
      ],
      abortSignal: abort.signal,
      context: {} as never,
      unstable_getMessage: (() => undefined) as never,
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
    const adapter = createHermesChatModelAdapter(() => 's1', { onPrivateRefused });
    const gen = adapter.run({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as never],
      abortSignal: new AbortController().signal,
      context: {} as never,
      unstable_getMessage: (() => undefined) as never,
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

    const adapter = createHermesChatModelAdapter(() => 's1', { onLocalUnreachable });
    const gen = adapter.run({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as never],
      abortSignal: new AbortController().signal,
      context: {} as never,
    } as never) as AsyncGenerator<{ metadata?: { custom?: unknown } }>;
    expect((await gen.next()).value?.metadata?.custom).toEqual({ noReply: { reason: 'unreachable', error } });
    expect((await gen.next()).done).toBe(true);
    expect(onLocalUnreachable).toHaveBeenCalledOnce();
  });

  it('puts a refused shared model in the transcript, not an empty reply', async () => {
    useRequestId('req-refused');
    const error = 'Ada’s qwen3:14b is offline. Your message wasn’t sent.';
    startChat.mockResolvedValue({ success: false, requestId: 'req-refused', errorCode: 'apply-failed', error });

    const gen = createHermesChatModelAdapter(() => 's1').run({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as never],
      abortSignal: new AbortController().signal,
      context: {} as never,
    } as never) as AsyncGenerator<{ metadata?: { custom?: unknown } }>;
    expect((await gen.next()).value?.metadata?.custom).toEqual({ noReply: { reason: 'unreachable', error } });
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

    const adapter = createHermesChatModelAdapter(() => 's1', { onLocalUnreachable });
    const abort = new AbortController();
    const gen = adapter.run({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        } as never,
      ],
      abortSignal: abort.signal,
      context: {} as never,
      unstable_getMessage: (() => undefined) as never,
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
    adapter.run({
      messages,
      abortSignal: new AbortController().signal,
      context: {} as never,
      unstable_assistantMessageId: assistantId,
      unstable_getMessage: (() => undefined) as never,
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
    const tools: Array<(e: Record<string, unknown>) => void> = [];
    onChatTool.mockImplementation((cb: (e: Record<string, unknown>) => void) => {
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
    runConfig?: unknown
  ) =>
    adapter.run({
      messages,
      abortSignal: new AbortController().signal,
      context: {} as never,
      unstable_assistantMessageId: assistantId,
      unstable_getMessage: (() => undefined) as never,
      ...(runConfig ? { runConfig } : {}),
    } as never);

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
    const gen = adapter.run({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] } as never],
      abortSignal: new AbortController().signal,
      context: {} as never,
      unstable_getMessage: (() => undefined) as never,
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

  async function runWithTool(event: Record<string, unknown>) {
    let toolCb: ((e: Record<string, unknown>) => void) | null = null;
    let endCb: ((e: { requestId: string }) => void) | null = null;
    onChatTool.mockImplementation(((cb: (e: Record<string, unknown>) => void) => {
      toolCb = cb;
      return () => undefined;
    }) as never);
    onChatChunk.mockImplementation(() => () => undefined);
    onChatEnd.mockImplementation((cb) => {
      endCb = cb;
      return () => undefined;
    });
    onChatError.mockImplementation(() => () => undefined);
    useRequestId('req-kanban');
    startChat.mockResolvedValue({ success: true, requestId: 'req-kanban', sessionId: 's1' });

    const adapter = createHermesChatModelAdapter(() => 's1');
    const gen = adapter.run({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'file it' }] } as never],
      abortSignal: new AbortController().signal,
      context: {} as never,
      unstable_getMessage: (() => undefined) as never,
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
