import { describe, expect, it, vi, beforeEach } from 'vitest';
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

vi.mock('../../../services/hermesChatIPCService', () => ({
  hermesChatIPC: {
    startChat: (...args: unknown[]) => startChat(...args),
    cancelChat: (...args: unknown[]) => cancelChat(...args),
    onChatChunk: (...args: unknown[]) => onChatChunk(...args),
    onChatEnd: (...args: unknown[]) => onChatEnd(...args),
    onChatError: (...args: unknown[]) => onChatError(...args),
    onChatTool: (...args: unknown[]) => onChatTool(...args),
  },
}));

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

    startChat.mockResolvedValue({ success: true, requestId: 'req-1', sessionId: 'session-1', transport: 'json-rpc' });

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
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-room',
      sessionId: 'chan-1',
      transport: 'json-rpc',
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
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-abort',
      sessionId: 's1',
      transport: 'http',
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
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-detach',
      sessionId: 's1',
      transport: 'http',
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
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-2',
      sessionId: 'gateway-session',
      transport: 'json-rpc',
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
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-tools',
      sessionId: 's1',
      transport: 'json-rpc',
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

  it('returns without an assistant turn when start reports a channel post', async () => {
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-post',
      sessionId: 'chan-1',
      transport: 'json-rpc',
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

    expect(yields).toEqual([]);
    expect(onChatChunk).not.toHaveBeenCalled();
    expect(onChatEnd).not.toHaveBeenCalled();
  });

  it('does not throw a generic error when start reports local-unreachable', async () => {
    const onLocalUnreachable = vi.fn();
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
    expect(onChatChunk).not.toHaveBeenCalled();
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

  it('stops offering rewinds after an HTTP-fallback turn', async () => {
    const path = new ServerPath();
    const adapter = createHermesChatModelAdapter(() => 's1', { getServerPath: () => path });
    onChatEnd.mockImplementation((cb) => {
      queueMicrotask(() => cb({ requestId: 'req-http' }));
      return () => undefined;
    });
    startChat.mockResolvedValueOnce({
      success: true,
      requestId: 'req-http',
      sessionId: 's1',
      transport: 'http',
    });
    await drain(run(adapter, [user('u1', 'hi')], 'a1'));
    expect(path.canRewind()).toBe(false);
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
    startChat.mockResolvedValueOnce({
      success: true,
      requestId: 'req-files',
      sessionId: 's1',
      transport: 'json-rpc',
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
    startChat.mockResolvedValue({
      success: true,
      requestId: 'req-cont',
      sessionId: 's1',
      transport: 'json-rpc',
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
});
