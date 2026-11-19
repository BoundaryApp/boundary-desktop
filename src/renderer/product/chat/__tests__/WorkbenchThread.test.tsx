import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { HermesChatBreakdownResult, HermesProjectRecord, PoolServedTurn, TurnWindow } from '../../../../shared/types/hermesChat';
import type { PoolStop } from '../../../../shared/types/confidentialState';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';

const noop = (): void => undefined;

const streamdownRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => {
    streamdownRenders.count += 1;
    return <div>{children}</div>;
  },
}));

stubElectronAPI({
  hermesChat: {
    listPendingCredentialRequests: vi.fn(async () => []),
    respondCredentialRequest: vi.fn(async () => ({ success: true })),
    getContextBreakdown: async (): Promise<HermesChatBreakdownResult> => ({
      success: true,
      breakdown: {
        categories: [],
        contextUsed: 0,
        contextMax: 0,
        contextPercent: 0,
        contextEstimated: false,
      },
    }),
  },
  onboarding: {
    getStatus: vi.fn().mockResolvedValue({ configured: true, slots: {} }),
  },
  projects: {
    completePath: vi.fn().mockResolvedValue({ success: true, items: [] }),
  },
});

// What main resolves for the chat. With only `afterRefresh` set, main first answers Local, which
// its probe finds unreachable, then `afterRefresh` once the thread asks again.
const main = vi.hoisted(() => ({
  afterRefresh: null as unknown,
  current: null as unknown,
  poolTurns: [] as unknown[],
  turnWindows: [] as TurnWindow[],
  asked: 0,
  lastHealth: undefined as string | undefined,
}));
const localUnreachable = { slot: 'local', modelId: 'qwen3:14b', health: 'unreachable', provenance: 'app-default', configured: true };

stubElectronAPI({
  hermesChat: {
    getSessionInference: vi.fn(async () => {
      const resolved = (
        main.asked > 0 && main.afterRefresh ? main.afterRefresh : main.current ?? (main.afterRefresh ? localUnreachable : null)
      ) as { health?: string } | null;
      main.asked += 1;
      main.lastHealth = resolved?.health;
      return { success: true, override: null, resolved, marks: [], poolTurns: main.poolTurns, turnWindows: main.turnWindows };
    }),
  },
  onboarding: {
    probeSlotHealth: vi.fn(async () => ({ health: main.lastHealth ?? 'reachable' })),
  },
});

// The chip is not mounted: the thread's marks, reply lines, offline prompt and send gate come
// from what main resolves, not from the chip.
vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

// A leftover afterRefresh makes main answer Local unreachable, which holds every send.
afterEach(() => {
  main.current = null;
  main.afterRefresh = null;
  main.poolTurns = [];
  main.turnWindows = [];
  main.asked = 0;
  main.lastHealth = undefined;
});

import { WorkbenchThread } from '../WorkbenchThread';
import { HostedChatRuntime } from './threadHarness';
import { takeInferenceStatus } from '../../../onboarding/inferenceStatus';
import { poolMoveMarks, poolReplyTurns } from '../PoolReplyLine';
import { CONFIDENTIAL_COPY } from '../../inference/confidentialCopy';

const adapter = {
  async *run() {
    yield { content: [{ type: 'text' as const, text: 'ok' }] };
  },
};

const Harness: React.FC<{
  initialMessages?: {
    role: 'user' | 'assistant';
    content: string;
    createdAt?: Date;
    metadata?: { custom: Record<string, unknown> };
  }[];
  chatAdapter?: typeof adapter;
  connecting?: boolean;
  project?: HermesProjectRecord | null;
  onProjectsUpdated?: (projects: HermesProjectRecord[]) => void;
}> = ({ initialMessages, chatAdapter = adapter, connecting = false, project = null, onProjectsUpdated }) => {
  const runtime = useLocalRuntime(chatAdapter, { initialMessages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkbenchThread
        sessionId="s1"
        threadTitle="Assistant"
        connecting={connecting}
        activeProject={project}
        projects={project ? [project] : []}
        activeProjectId={project?.id ?? null}
        onProjectsUpdated={onProjectsUpdated}
        toolsEnabled
        onToolsEnabledChange={() => undefined}
        onSelectProject={() => undefined}
        onClearProject={() => undefined}
        onNewProject={() => undefined}
        onCreateAgentFromDraft={() => undefined}
        onEditAgentDraft={() => undefined}
      />
    </AssistantRuntimeProvider>
  );
};

const setNativeValue = (el: HTMLTextAreaElement, value: string, caret: number) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    el,
    value
  );
  el.setSelectionRange(caret, caret);
};

describe('WorkbenchThread composer', () => {
  afterEach(() => cleanup());

  it('locks the composer while the folder connects, as it disables the input', async () => {
    const { container } = render(<Harness connecting />);
    const input = screen.getByPlaceholderText('Connecting folder…') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(container.querySelector('.wb-composer')?.classList.contains('is-locked')).toBe(true);
  });

  it('keeps the caret where the user typed mid-text', async () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;

    await act(async () => {
      setNativeValue(input, 'hello world', 11);
      fireEvent.input(input);
    });

    // Click back to after "hello" and type one character.
    await act(async () => {
      setNativeValue(input, 'helloX world', 6);
      fireEvent.input(input);
    });

    expect(input.value).toBe('helloX world');
    expect(input.selectionStart).toBe(6);
  });

  it('does not re-render messages when the parent re-renders with fresh callbacks', async () => {
    const initialMessages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: '**hello**' },
      { role: 'user' as const, content: 'again' },
      { role: 'assistant' as const, content: '**hello again**' },
    ];
    const { rerender } = render(<Harness initialMessages={initialMessages} />);
    await screen.findByText('**hello again**');

    const before = streamdownRenders.count;
    rerender(<Harness initialMessages={initialMessages} />);

    expect(streamdownRenders.count).toBe(before);
  });
});

describe('WorkbenchThread failed send (decision D3)', () => {
  afterEach(() => cleanup());

  it('shows why a reply failed, with Retry that runs it again', async () => {
    let runs = 0;
    const flaky = {
      async *run() {
        runs += 1;
        if (runs === 1) throw new Error("Couldn't reach the assistant stack: connect ECONNREFUSED.");
        yield { content: [{ type: 'text' as const, text: 'back again' }] };
      },
    };
    render(<Harness chatAdapter={flaky} />);
    const input = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(input, 'hello', 5);
      fireEvent.input(input);
    });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't reach the assistant stack/);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    expect(await screen.findByText('back again')).toBeTruthy();
    expect(runs).toBe(2);
  });
});

describe('WorkbenchThread in a private project', () => {
  afterEach(() => {
    cleanup();
    main.current = null;
  });

  const status = (localConfigured: boolean) =>
    takeInferenceStatus({
      status: {
        configured: true,
        encryptionAvailable: true,
        appDefault: 'openrouter',
        slots: {
          local: { configured: localConfigured, modelId: 'qwen3:14b' },
          openrouter: { configured: true, modelId: 'anthropic/claude-sonnet-4' },
        },
      },
    });
  const refused = {
    slot: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4',
    provenance: 'chat-override',
    configured: true,
    privacyLocked: true,
    privacyRefused: true,
  };

  it('holds the send, says why, and offers the local model', async () => {
    main.current = refused;
    const setSessionInference = vi.fn().mockResolvedValue({ success: true });
    stubElectronAPI({ hermesChat: { setSessionInference } });
    await status(true);
    const run = vi.fn(async function* () {
      yield { content: [{ type: 'text' as const, text: 'ok' }] };
    });
    await act(async () => void render(<Harness chatAdapter={{ run }} />));
    expect(screen.getByRole('alert').textContent).toMatch(/private and this chat’s model isn’t/);
    const input = screen.getByPlaceholderText(/This project is private/) as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(input, 'secret plans', 12);
      fireEvent.input(input);
    });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(run).not.toHaveBeenCalled();

    main.afterRefresh = { ...refused, slot: 'local', modelId: 'qwen3:14b', privacyRefused: false };
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send with Local · qwen3:14b' })));
    expect(setSessionInference).toHaveBeenCalledWith({ sessionId: 's1', provider: 'local', modelId: 'qwen3:14b' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(run).toHaveBeenCalled();
  });

  it('says what to connect when there is no local model', async () => {
    main.current = refused;
    await status(false);
    await act(async () => void render(<Harness />));
    expect(screen.getByRole('alert').textContent).toMatch(/Connect a local model in Settings/);
    expect(screen.queryByRole('button', { name: /Send with/ })).toBeNull();
  });

  it('never offers OpenRouter when a private chat finds Local unreachable', async () => {
    main.current = { ...refused, slot: 'local', modelId: 'qwen3:14b', health: 'unreachable', privacyRefused: false };
    await status(true);
    await act(async () => void render(<Harness />));
    const input = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(input, 'hello', 5);
      fireEvent.input(input);
    });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(screen.getByText(/Local model unreachable/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send via OpenRouter' })).toBeNull();
  });
});

describe('WorkbenchThread when a private project’s pool has no provider at its level', () => {
  afterEach(() => cleanup());

  const status = (localConfigured: boolean) =>
    takeInferenceStatus({
      status: {
        configured: true,
        encryptionAvailable: true,
        appDefault: 'openrouter',
        slots: {
          local: { configured: localConfigured, modelId: 'qwen3:14b' },
          openrouter: { configured: true, modelId: 'anthropic/claude-sonnet-4' },
        },
      },
    });
  const stop: PoolStop = {
    modelId: 'qwen',
    floor: 'A',
    lowestPrecision: 'fp8',
    providers: [
      { providerId: 'prem', name: 'Prem', level: 'B', precision: null, reason: 'below-level' },
      { providerId: 'chutes', name: 'Chutes', level: 'C', precision: 'fp4', reason: 'precision' },
    ],
  };
  const refused = {
    slot: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4',
    provenance: 'project-pin',
    configured: true,
    privacyLocked: true,
    privacyRefused: true,
    projectFloor: 'A',
    poolStop: stop,
  };
  const project = {
    id: 'p1',
    name: 'Board',
    hostPath: '/tmp/board',
    inference: { mode: 'openrouter', modelId: 'anthropic/claude-sonnet-4', privacyLocalOnly: true },
  } as unknown as HermesProjectRecord;

  const typeAndSend = async (text: string) => {
    const input = screen.getByPlaceholderText(/This project is private/) as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(input, text, text.length);
      fireEvent.input(input);
    });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
  };

  it('says the project’s level, why each provider misses it, and offers the three ways forward', async () => {
    main.current = refused;
    await status(true);
    await act(async () => void render(<Harness project={project} />));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/No provider you’ve added meets this project’s level A\./);
    const items = [...alert.querySelectorAll('li')].map((item) => item.textContent);
    expect(items).toEqual([
      'Prem B: Level B is below your minimum, A.',
      'Chutes C: Runs at fp4, below your lowest precision, fp8.',
    ]);
    for (const name of ['Allow level B for this project', 'Add a level A provider', 'Use Local for this chat']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false);
    }
    expect(alert.textContent).not.toMatch(/this chat’s model isn’t/);
  });

  it('Allow level B stores it on the project and sends the held message', async () => {
    main.current = refused;
    const updated = [{ ...project, inference: { ...project.inference, allowConfidentialLevelB: true } }];
    const patch = vi.fn().mockResolvedValue({ success: true, projects: updated });
    stubElectronAPI({ projects: { patch } });
    await status(true);
    const onProjectsUpdated = vi.fn();
    const run = vi.fn(async function* () {
      yield { content: [{ type: 'text' as const, text: 'ok' }] };
    });
    await act(async () => void render(<Harness chatAdapter={{ run }} project={project} onProjectsUpdated={onProjectsUpdated} />));
    await typeAndSend('board minutes');
    expect(run).not.toHaveBeenCalled();

    main.afterRefresh = { ...refused, slot: 'confidential', modelId: 'qwen', privacyRefused: false, projectFloor: 'B', poolStop: undefined };
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Allow level B for this project' })));
    expect(patch).toHaveBeenCalledWith({
      projectId: 'p1',
      inference: {
        mode: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4',
        privacyLocalOnly: true,
        allowConfidentialLevelB: true,
      },
    });
    expect(onProjectsUpdated).toHaveBeenCalledWith(updated);
    expect(run).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the stop and says why when the project can’t be updated', async () => {
    main.current = refused;
    const patch = vi.fn().mockResolvedValue({ success: false, error: 'Project not found.' });
    stubElectronAPI({ projects: { patch } });
    await status(true);
    const run = vi.fn(async function* () {
      yield { content: [{ type: 'text' as const, text: 'ok' }] };
    });
    await act(async () => void render(<Harness chatAdapter={{ run }} project={project} />));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Allow level B for this project' })));
    expect(screen.getByRole('alert').textContent).toMatch(/Project not found\./);
    expect(run).not.toHaveBeenCalled();
  });

  it('hides Allow level B once the project allows it', async () => {
    main.current = {
      ...refused,
      projectFloor: 'B',
      poolStop: { ...stop, floor: 'B', providers: [{ ...stop.providers[1], reason: 'below-level' }] },
    };
    await status(true);
    await act(async () => void render(<Harness project={project} />));
    expect(screen.getByRole('alert').textContent).toMatch(/meets this project’s level B\./);
    expect(screen.queryByRole('button', { name: 'Allow level B for this project' })).toBeNull();
  });

  it('Add a level A provider opens Inference with the add sheet', async () => {
    main.current = refused;
    await status(true);
    const opened = vi.fn();
    const listener = (event: Event) => opened((event as CustomEvent).detail);
    window.addEventListener('boundary:open-inference', listener);
    try {
      await act(async () => void render(<Harness project={project} />));
      fireEvent.click(screen.getByRole('button', { name: 'Add a level A provider' }));
      expect(opened).toHaveBeenCalledWith({ addConfidentialProvider: true });
    } finally {
      window.removeEventListener('boundary:open-inference', listener);
    }
  });

  it('Use Local for this chat moves the chat to the local model and sends', async () => {
    main.current = refused;
    const setSessionInference = vi.fn().mockResolvedValue({ success: true });
    stubElectronAPI({ hermesChat: { setSessionInference } });
    await status(true);
    const run = vi.fn(async function* () {
      yield { content: [{ type: 'text' as const, text: 'ok' }] };
    });
    await act(async () => void render(<Harness chatAdapter={{ run }} project={project} />));
    await typeAndSend('board minutes');
    main.afterRefresh = { ...refused, slot: 'local', modelId: 'qwen3:14b', privacyRefused: false, poolStop: undefined };
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use Local for this chat' })));
    expect(setSessionInference).toHaveBeenCalledWith({ sessionId: 's1', provider: 'local', modelId: 'qwen3:14b' });
    expect(run).toHaveBeenCalled();
  });

  it('disables Use Local and says what to connect when there is no local model', async () => {
    main.current = refused;
    await status(false);
    await act(async () => void render(<Harness project={project} />));
    expect((screen.getByRole('button', { name: 'Use Local for this chat' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/Connect a local model in Settings/);
  });
});

describe('WorkbenchThread offline prompt', () => {
  afterEach(() => {
    cleanup();
    main.afterRefresh = null;
  });

  it('after Send via OpenRouter, the next Enter sends without the prompt', async () => {
    main.afterRefresh = {
      slot: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
      provenance: 'chat-override',
      configured: true,
    };
    const setSessionInference = vi.fn().mockResolvedValue({ success: true });
    stubElectronAPI({ hermesChat: { setSessionInference } });
    await takeInferenceStatus({
      status: {
        configured: true,
        encryptionAvailable: true,
        appDefault: 'local',
        slots: {
          local: { configured: true, modelId: 'qwen3:14b' },
          openrouter: { configured: true, modelId: 'anthropic/claude-sonnet-4' },
        },
      },
    });
    render(<Harness />);
    const input = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;
    const type = async (text: string) =>
      act(async () => {
        setNativeValue(input, text, text.length);
        fireEvent.input(input);
      });

    await type('first');
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send via OpenRouter' })));
    expect(setSessionInference).toHaveBeenCalledWith({
      sessionId: 's1',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
    });
    expect(screen.queryByText(/Local model unreachable/)).toBeNull();

    await type('second');
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(screen.queryByText(/Local model unreachable/)).toBeNull();
  });

  it('in a chat with no session yet, Send via OpenRouter sends with the override', async () => {
    main.afterRefresh = {
      slot: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
      provenance: 'chat-override',
      configured: true,
    };
    const setSessionInference = vi.fn().mockResolvedValue({ success: true });
    // The reply never streams; the turn ends when the test unmounts the chat.
    const startChat = vi.fn(async (payload: { requestId: string }) => ({
      success: true,
      requestId: payload.requestId,
      sessionId: 's-new',
    }));
    stubElectronAPI({ hermesChat: { setSessionInference, startChat } });
    await takeInferenceStatus({
      status: {
        configured: true,
        encryptionAvailable: true,
        appDefault: 'local',
        slots: {
          local: { configured: true, modelId: 'qwen3:14b' },
          openrouter: { configured: true, modelId: 'anthropic/claude-sonnet-4' },
        },
      },
    });
    render(
      <HostedChatRuntime sessionId={null}>
        <WorkbenchThread
          sessionId={null}
          threadTitle="New chat"
          kind="hermes"
          activeProject={null}
          projects={[]}
          activeProjectId={null}
          toolsEnabled
          onToolsEnabledChange={noop}
          onSelectProject={noop}
          onClearProject={noop}
          onNewProject={noop}
        />
      </HostedChatRuntime>
    );
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(input, 'first', 5);
      fireEvent.input(input);
    });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(startChat).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send via OpenRouter' })));
    expect(setSessionInference).not.toHaveBeenCalled();
    expect(startChat).toHaveBeenCalledTimes(1);
    expect(startChat.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        sessionId: undefined,
        messages: [{ role: 'user', content: 'first' }],
        inference: { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' },
      })
    );
  });
});

describe('WorkbenchThread draft card', () => {
  afterEach(() => cleanup());

  it('shows the card in place of the raw agent-draft fence', async () => {
    const reply = [
      'Here is a draft.',
      '',
      '```agent-draft',
      'displayName: Staff Recruiter',
      'handle: staff-recruiter',
      'role: Own outreach.',
      '```',
    ].join('\n');
    render(
      <Harness
        initialMessages={[
          { role: 'user', content: 'draft one' },
          { role: 'assistant', content: reply },
        ]}
      />
    );

    expect(await screen.findByText('Staff Recruiter')).toBeTruthy();
    expect(screen.getByText('Here is a draft.')).toBeTruthy();
    expect(screen.queryByText(/agent-draft/)).toBeNull();
  });
});

describe('WorkbenchThread replies a confidential pool answered (spec decision 9)', () => {
  afterEach(() => cleanup());

  const t0 = Date.parse('2026-11-12T10:00:00Z');
  const at = (seconds: number): Date => new Date(t0 + seconds * 1_000);
  /** A pool record past its turn's gate at `seconds`; its window opened half a second earlier. */
  const turn = (seconds: number, providerId: string, providerName: string, level: 'A' | 'B', moved: PoolServedTurn['moved']): PoolServedTurn => ({
    at: at(seconds).toISOString(),
    windowStartedAt: at(seconds - 0.5).toISOString(),
    modelId: 'qwen',
    providerId,
    providerName,
    level,
    moved,
    mixedProviders: false,
  });

  /** A turn's window from the send reaching main; null `end` while it runs. */
  const span = (start: number, end: number | null): TurnWindow => ({
    startedAt: at(start).toISOString(),
    endedAt: end == null ? null : at(end).toISOString(),
  });

  /** A message as history loads it: Hermes's stored time in `custom.ts`, in seconds. */
  const stored = (role: 'user' | 'assistant', content: string, seconds: number) => ({
    role,
    content,
    createdAt: at(seconds),
    metadata: { custom: { ts: at(seconds).getTime() / 1_000 } },
  });

  it('names the provider under each reply, and marks once where another took over', async () => {
    main.poolTurns = [turn(1, 'near', 'NEAR AI', 'B', 'new-session'), turn(61, 'prem', 'Prem', 'A', 'rate-limited')];
    // The third turn went elsewhere: it left a window but no pool record.
    main.turnWindows = [span(0.5, 8), span(60.5, 70), span(119.5, 130)];
    const { container } = render(
      <Harness
        initialMessages={[
          stored('user', 'first question', 0),
          stored('assistant', 'first answer', 5),
          stored('user', 'second question', 60),
          stored('assistant', 'second answer', 65),
          stored('assistant', 'second answer, more', 66),
          stored('user', 'third question', 120),
          stored('assistant', 'third answer', 125),
        ]}
      />
    );
    await screen.findByText('third answer');
    const replies = Array.from(container.querySelectorAll('.wb-msg.is-assistant'));
    const line = (reply: Element): string | null => reply.querySelector('.wb-reply-prov')?.textContent ?? null;
    // The line's text, then the level badge's letter.
    expect(replies.map(line)).toEqual(['qwen · NEAR AIB', 'qwen · PremA', 'qwen · PremA', null]);
    expect(replies[1].querySelector('.wb-reply-prov .wb-conf-level')?.getAttribute('title')).toBe(
      'Level A: Checked hardware and code'
    );
    // One marker, above the first reply Prem wrote; none for the chat's first provider.
    expect(screen.getAllByText(/took over/).map((el) => el.textContent)).toEqual(['Prem took over: rate limited']);
    const marker = screen.getByText('Prem took over: rate limited');
    expect(replies[1].contains(marker)).toBe(true);
    expect(replies[1].textContent!.indexOf('took over')).toBeLessThan(replies[1].textContent!.indexOf('second answer'));
  });

  it('gives a live reply its line from when its turn finished, and none without that time', async () => {
    main.poolTurns = [turn(1, 'near', 'NEAR AI', 'B', null), turn(61, 'prem', 'Prem', 'A', 'rate-limited')];
    // The second turn's window ended at the same instant its end event carried; the third runs.
    main.turnWindows = [span(0.5, 8), span(60.5, 70), span(120.5, null)];
    const { container } = render(
      <Harness
        initialMessages={[
          stored('user', 'first question', 0),
          stored('assistant', 'first answer', 5),
          // Live turns: the runtime dated each reply when its run began, before main noted the
          // turn's start. The finished one carries when main saw it end; the stopped one doesn't.
          { role: 'user', content: 'second question', createdAt: at(60) },
          {
            role: 'assistant',
            content: 'second answer',
            createdAt: at(60),
            metadata: { custom: { turnEndedAt: at(70).getTime() } },
          },
          { role: 'user', content: 'third question', createdAt: at(120) },
          { role: 'assistant', content: 'third answer', createdAt: at(120) },
        ]}
      />
    );
    await screen.findByText('third answer');
    const replies = Array.from(container.querySelectorAll('.wb-msg.is-assistant'));
    expect(replies.map((reply) => reply.querySelector('.wb-reply-prov')?.textContent ?? null)).toEqual([
      'qwen · NEAR AIB',
      'qwen · PremA',
      null,
    ]);
    expect(screen.getAllByText(/took over/).map((el) => el.textContent)).toEqual(['Prem took over: rate limited']);
    expect(replies[1].contains(screen.getByText('Prem took over: rate limited'))).toBe(true);
  });

  const replyTimes = (...seconds: number[]): string => seconds.map((n) => `${t0 + n * 1_000} a${n}`).join('\n');

  it('gives no line or marker to a reply written while a queued send’s turn had begun', async () => {
    // Turn N ran 0.5–30 s. Turn N+1 was queued: its send reached main at 10 s, while N still ran.
    main.poolTurns = [turn(1, 'near', 'NEAR AI', 'B', null), turn(10.5, 'prem', 'Prem', 'A', 'rate-limited')];
    main.turnWindows = [span(0.5, 30), span(10, 50)];
    const { container } = render(
      <Harness
        initialMessages={[
          stored('user', 'first question', 0),
          stored('user', 'second question', 9),
          stored('assistant', 'first answer', 25),
          stored('assistant', 'second answer', 45),
        ]}
      />
    );
    await screen.findByText('second answer');
    const replies = Array.from(container.querySelectorAll('.wb-msg.is-assistant'));
    expect(replies.map((reply) => reply.querySelector('.wb-reply-prov')?.textContent ?? null)).toEqual([
      null,
      'qwen · PremA',
    ]);
    // The marker sits above N+1's own reply, not above N's, which N+1's record is dated before.
    expect(screen.getAllByText(/took over/)).toHaveLength(1);
    expect(replies[0].textContent).not.toContain('took over');
    expect(replies[1].contains(screen.getByText('Prem took over: rate limited'))).toBe(true);
  });

  it('gives N+1’s reply its line only once N has ended, so no other window holds it', () => {
    const turns = [turn(1, 'near', 'NEAR AI', 'B', null), turn(15.5, 'prem', 'Prem', 'A', null)];
    // While N runs, both windows are open and hold every reply near or after 15 s.
    let owners = poolReplyTurns(turns, [span(0.5, null), span(15, null)], replyTimes(5, 25));
    expect([...owners].map(([id, t]) => [id, t.providerId])).toEqual([['a5', 'near']]);
    owners = poolReplyTurns(turns, [span(0.5, 30), span(15, 50)], replyTimes(5, 25, 45));
    expect([...owners].map(([id, t]) => [id, t.providerId])).toEqual([
      ['a5', 'near'],
      ['a45', 'prem'],
    ]);
  });

  it('gives no line to a reply outside every window, or to a window without a pool record', () => {
    const owners = poolReplyTurns(
      [turn(1, 'near', 'NEAR AI', 'B', null), { ...turn(40, 'near', 'NEAR AI', 'B', null), windowStartedAt: null }],
      // Turn two (20 s) went elsewhere; turn three's record names no window.
      [span(0.5, 8), span(20, 30), span(39.5, 50)],
      replyTimes(5, 14, 25, 45)
    );
    expect([...owners.keys()]).toEqual(['a5']);
  });

  it('gives no line to a reply of a turn an earlier app run left open, inside the next turn’s window', () => {
    // Main reads the open window as ending where N+1's does, so both hold the reply.
    const owners = poolReplyTurns(
      [turn(1, 'near', 'NEAR AI', 'B', null), turn(40.5, 'prem', 'Prem', 'A', null)],
      [span(0.5, 60), span(40, 60)],
      replyTimes(45)
    );
    expect(owners.size).toBe(0);
  });

  it('gives no line to reply N when N+1 never ran and N+2 began before N’s reply landed', () => {
    // An earlier run quit mid-turn N; N+1 closed at its start; main ends N where N+2 ends.
    const owners = poolReplyTurns(
      [turn(1, 'near', 'NEAR AI', 'B', null), turn(30.5, 'prem', 'Prem', 'A', null)],
      [span(0.5, 40), span(20, 20), span(30, 40)],
      replyTimes(31)
    );
    expect(owners.size).toBe(0);
  });

  it('gives no line or marker to any reply of a turn more than one provider answered', () => {
    const mixed = { ...turn(1, 'prem', 'Prem', 'A', 'rate-limited'), mixedProviders: true };
    // A room wake: two agents replied, and the first one's provider isn't known.
    let owners = poolReplyTurns([mixed], [span(0.5, 30)], replyTimes(10, 20));
    expect(owners.size).toBe(0);
    expect(poolMoveMarks(owners, replyTimes(10, 20), () => 'moved').before.size).toBe(0);
    // One reply: a title or memory review after it may have gone to another provider (ADR 0033 §7).
    owners = poolReplyTurns([mixed], [span(0.5, 30)], replyTimes(20));
    expect(owners.size).toBe(0);
    expect(poolMoveMarks(owners, replyTimes(20), () => 'moved').before.size).toBe(0);
  });

  it('gives no line to a reply stored just past its turn’s end, once the next turn has begun', () => {
    // N ended at 30 s and N+1 began at 30.5 s; Hermes's clock put reply N at 31 s.
    const turns = [turn(1, 'near', 'NEAR AI', 'B', null), turn(31, 'prem', 'Prem', 'A', null)];
    const owners = poolReplyTurns(turns, [span(0.5, 30), span(30.5, 60)], replyTimes(15, 31, 45));
    expect([...owners].map(([id, t]) => [id, t.providerId])).toEqual([
      ['a15', 'near'],
      ['a45', 'prem'],
    ]);
  });

  it('gives no line to a reply from before the oldest window kept', () => {
    // The window of the turn at 0–10 s was dropped at the cap; only N (20 s) and N+1 remain.
    const owners = poolReplyTurns(
      [turn(20.5, 'near', 'NEAR AI', 'B', null), turn(40.5, 'near', 'NEAR AI', 'B', null)],
      [span(20, 30), span(40, 50)],
      replyTimes(16, 25, 45)
    );
    expect([...owners.keys()]).toEqual(['a25', 'a45']);
  });

  it('counts a reply at the instant its window ended as inside it', () => {
    const owners = poolReplyTurns([turn(1, 'near', 'NEAR AI', 'B', null)], [span(0.5, 8)], replyTimes(8));
    expect([...owners.keys()]).toEqual(['a8']);
  });

  it('says why another provider took over, and nothing for a chat’s first provider', () => {
    const reasons: [PoolServedTurn['moved'], string | null][] = [
      ['rate-limited', 'P took over: rate limited'],
      ['no-balance', 'P took over: out of balance'],
      ['bad-key', 'P took over: key refused'],
      ['unreachable', 'P took over: not answering'],
      ['attestation-failed', 'P took over: hardware check failed'],
      ['server', 'P took over: server error'],
      ['stopped-serving', 'P took over: no longer serves this model'],
      ['new-session', null],
      [null, null],
    ];
    for (const [moved, text] of reasons) expect(CONFIDENTIAL_COPY.tookOver('P', moved)).toBe(text);
  });
});

describe('WorkbenchThread credential prompt', () => {
  afterEach(() => cleanup());

  it('shows a prompt that was still waiting when the thread mounted', async () => {
    vi.mocked(window.electronAPI.hermesChat.listPendingCredentialRequests).mockResolvedValueOnce([
      { rpcRequestId: 'rpc-9', sessionId: 'runtime-1', kind: 'secret', envVar: 'GITHUB_TOKEN' },
    ]);
    render(<Harness />);
    expect(await screen.findByText('Secret needed · GITHUB_TOKEN')).toBeTruthy();
    expect(screen.getByPlaceholderText('Answer the prompt above to continue…')).toBeTruthy();
  });

  it('after saving a login, links to it in Passwords & Logins', async () => {
    vi.mocked(window.electronAPI.hermesChat.listPendingCredentialRequests).mockResolvedValueOnce([
      {
        rpcRequestId: 'rpc-10',
        sessionId: 'runtime-1',
        kind: 'vault.save_login',
        origin: 'https://www.linkedin.com',
        site: 'www.linkedin.com',
      },
    ]);
    const opened = vi.fn();
    window.addEventListener('boundary:open-settings', (e) => opened((e as CustomEvent).detail));
    render(<Harness />);
    await screen.findByText('Save login · www.linkedin.com');
    fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: 'me@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    });

    expect(window.electronAPI.hermesChat.respondCredentialRequest).toHaveBeenCalledWith({
      rpcRequestId: 'rpc-10',
      login: { identifier: 'me@example.com', password: 'hunter2' },
    });
    expect((await screen.findByText(/Saved the login for/)).textContent).toContain('www.linkedin.com');
    fireEvent.click(screen.getByRole('button', { name: 'Manage in Passwords & Logins' }));
    expect(opened).toHaveBeenCalledWith({ tab: 'passwords', agentSlug: 'assistant' });
  });

  const createLogin = {
    rpcRequestId: 'rpc-11',
    sessionId: 'runtime-1',
    kind: 'vault.create_login' as const,
    origin: 'https://app.example.com',
    site: 'app.example.com',
    identifier: 'me@example.com',
    regenerate: false,
  };

  it('approves a new login on a sign-up form, then frees the composer', async () => {
    vi.mocked(window.electronAPI.hermesChat.listPendingCredentialRequests).mockResolvedValueOnce([createLogin]);
    render(<Harness />);
    await screen.findByText('New login · app.example.com');
    expect(screen.getByPlaceholderText('Answer the prompt above to continue…')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Generate password/ }));
    });

    expect(window.electronAPI.hermesChat.respondCredentialRequest).toHaveBeenCalledWith({
      rpcRequestId: 'rpc-11',
      createLogin: { generate: true },
    });
    expect(screen.queryByText('New login · app.example.com')).toBeNull();
    expect(screen.queryByPlaceholderText('Answer the prompt above to continue…')).toBeNull();
  });

  it('declines a new login with an empty answer', async () => {
    vi.mocked(window.electronAPI.hermesChat.listPendingCredentialRequests).mockResolvedValueOnce([createLogin]);
    render(<Harness />);
    await screen.findByText('New login · app.example.com');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    });
    expect(window.electronAPI.hermesChat.respondCredentialRequest).toHaveBeenCalledWith({ rpcRequestId: 'rpc-11' });
    expect(screen.queryByText('New login · app.example.com')).toBeNull();
  });

  it('saves a captured key for the agent, then frees the composer', async () => {
    const capture = {
      rpcRequestId: 'rpc-12',
      sessionId: 'runtime-1',
      kind: 'vault.capture_secret' as const,
      origin: 'https://dash.example.com',
      site: 'dash.example.com',
      name: 'EXAMPLE_API_KEY',
      destination: 'env' as const,
      last4: 'a1b2',
      replaces: false,
    };
    vi.mocked(window.electronAPI.hermesChat.listPendingCredentialRequests).mockResolvedValueOnce([capture]);
    render(<Harness />);
    await screen.findByText('Save key · EXAMPLE_API_KEY');
    expect(screen.getByPlaceholderText('Answer the prompt above to continue…')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save key/ }));
    });

    expect(window.electronAPI.hermesChat.respondCredentialRequest).toHaveBeenCalledWith({
      rpcRequestId: 'rpc-12',
      approve: true,
    });
    expect(screen.queryByText('Save key · EXAMPLE_API_KEY')).toBeNull();
    expect(screen.queryByPlaceholderText('Answer the prompt above to continue…')).toBeNull();
  });

  it('drops a new-login card Hermes already timed out when the user answers it', async () => {
    vi.mocked(window.electronAPI.hermesChat.listPendingCredentialRequests).mockResolvedValueOnce([createLogin]);
    vi.mocked(window.electronAPI.hermesChat.respondCredentialRequest).mockResolvedValueOnce({
      success: false,
      error: 'No pending credential request for that id',
      errorCode: 'not-pending',
    });
    render(<Harness />);
    await screen.findByText('New login · app.example.com');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Generate password/ }));
    });
    expect(screen.queryByText('New login · app.example.com')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByPlaceholderText('Answer the prompt above to continue…')).toBeNull();
  });
});
