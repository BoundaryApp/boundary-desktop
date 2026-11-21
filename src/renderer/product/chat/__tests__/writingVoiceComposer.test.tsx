import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';
import { useAuiState } from '@assistant-ui/store';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { flushMenu, openMenu } from '../../../__tests__/openMenu';
import type { AgentProfile, HermesSessionWritingVoice } from '../../../../shared/types/hermesChat';
import type { WritingVoiceView } from '../../../../shared/types/writingVoices';

vi.mock('streamdown', () => ({ Streamdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { WorkbenchThread } from '../WorkbenchThread';

const voice = (id: string, name: string): WritingVoiceView => ({
  id,
  name,
  status: 'ready',
  pieces: 1,
  words: 1,
  createdAt: '',
  calibratedAt: null,
  sampleHash: '',
  style: null,
  samplesChanged: false,
  step: null,
});

const VOICES = [voice('news', 'News'), voice('plain', 'Plain working')];
const hob: AgentProfile = {
  slug: 'assistant',
  displayName: 'Marlow',
  handle: 'hob',
  role: 'r',
  builtIn: true,
  createdAt: '',
  chatRepliesVoiceId: 'plain',
};

let chatVoice: HermesSessionWritingVoice;
let voicesNow: WritingVoiceView[] = VOICES;
let voicesChanged: (() => void) | null = null;
const getChat = vi.fn(async () => ({ success: true as const, voice: chatVoice }));
const setChat = vi.fn(async (_id: string, voiceId: string | null) => {
  chatVoice = {
    voiceId,
    voiceName: VOICES.find((v) => v.id === voiceId)?.name ?? null,
    marks: [
      ...chatVoice.marks,
      {
        id: `m${chatVoice.marks.length}`,
        at: new Date().toISOString(),
        kind: voiceId ? ('kept' as const) : ('cleared' as const),
        voiceId,
        voiceName: VOICES.find((v) => v.id === voiceId)?.name ?? null,
      },
    ],
  };
  return { success: true as const, voice: chatVoice };
});

beforeEach(() => {
  chatVoice = { voiceId: null, voiceName: null, marks: [] };
  voicesNow = VOICES;
  voicesChanged = null;
  getChat.mockClear();
  setChat.mockClear();
  stubElectronAPI({
    hermesChat: {
      listPendingCredentialRequests: vi.fn(async () => []),
      getContextBreakdown: async () => ({
        success: true,
        breakdown: { categories: [] as unknown[], contextUsed: 0, contextMax: 0, contextPercent: 0, contextEstimated: false },
      }),
    },
    onboarding: {
      getStatus: vi.fn().mockResolvedValue({ configured: true, slots: {} }),
      probeSlotHealth: vi.fn().mockResolvedValue({ health: 'reachable' }),
    },
    projects: { completePath: vi.fn().mockResolvedValue({ success: true, items: [] }) },
    writingVoices: {
      list: vi.fn(async () => ({ success: true, voices: voicesNow })),
      onProgress: () => (): void => undefined,
      onChanged: (cb: () => void) => {
        voicesChanged = cb;
        return (): void => undefined;
      },
      getChat: (...a: unknown[]) => getChat(...(a as [])),
      setChat: (...a: unknown[]) => setChat(...(a as [string, string | null])),
    },
  });
});
afterEach(() => cleanup());

type Run = { text: string; runConfig: Record<string, unknown> | undefined };

function makeAdapter(runs: Run[], gate?: { wait: Promise<void> }) {
  return {
    async *run({ messages, runConfig }: { messages: readonly { content: readonly unknown[] }[]; runConfig?: { custom?: Record<string, unknown> } }) {
      const last = messages.at(-1)?.content[0] as { text?: string } | undefined;
      runs.push({ text: last?.text ?? '', runConfig: runConfig?.custom });
      if (gate) await gate.wait;
      yield { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  };
}

/** What the composer would hand a Retry (ActionBar Reload reads composer.runConfig). */
const probe = { runConfig: undefined as unknown };
const RunConfigProbe: React.FC = () => {
  probe.runConfig = useAuiState((s) => s.composer.runConfig);
  return null;
};

const ROOM = {
  id: 'ch1',
  slug: 'research',
  title: 'research',
  sessionId: 's1',
  memberSlugs: ['assistant'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const Harness: React.FC<{ chatAdapter: ReturnType<typeof makeAdapter>; room?: boolean }> = ({
  chatAdapter,
  room = false,
}) => {
  const runtime = useLocalRuntime(chatAdapter as never);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RunConfigProbe />
      <WorkbenchThread
        sessionId="s1"
        threadTitle="Marlow"
        kind={room ? 'channel' : 'hermes'}
        {...(room ? { channel: ROOM } : {})}
        agents={[hob]}
        activeProject={null}
        projects={[]}
        activeProjectId={null}
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

const setText = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  el.setSelectionRange(value.length, value.length);
  fireEvent.input(el);
};

async function mount(gate?: { wait: Promise<void> }, room = false) {
  const runs: Run[] = [];
  render(<Harness chatAdapter={makeAdapter(runs, gate)} room={room} />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  await act(async () => undefined);
  return { runs, input };
}

const type = async (input: HTMLTextAreaElement, value: string) => act(async () => setText(input, value));
const key = async (input: HTMLTextAreaElement, k: string, extra: Record<string, unknown> = {}) =>
  act(async () => {
    fireEvent.keyDown(input, { key: k, ...extra });
  });

describe('writing voices in the composer', () => {
  it('opens on / at the start, filters as you type, and tags the agent voice', async () => {
    const { input } = await mount();
    await type(input, '/');
    const menu = screen.getByRole('listbox', { name: 'Commands' });
    expect(within(menu).getByText('Writing voices')).toBeTruthy();
    expect(within(menu).getByText('Marlow replies in this')).toBeTruthy();
    await type(input, '/ne');
    expect(within(menu).getByText('News')).toBeTruthy();
    expect(within(menu).queryByText('Plain working')).toBeNull();
  });

  it('names the active voice from the composer as the arrows move', async () => {
    const { input } = await mount();
    await type(input, '/');
    const menu = screen.getByRole('listbox', { name: 'Commands' });
    const options = within(menu).getAllByRole('option');
    expect(input.getAttribute('aria-controls')).toBe(menu.id);
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);
    await key(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);
    expect(options[1].hasAttribute('data-active')).toBe(true);
  });

  it('puts a chip on the message with Enter and sends its voice once', async () => {
    const { input, runs } = await mount();
    await type(input, '/ne');
    await key(input, 'Enter');
    expect(input.value).toBe('');
    expect(screen.getByText('✎ News')).toBeTruthy();
    await type(input, 'hello');
    await key(input, 'Enter');
    await screen.findByText('ok');
    expect(runs[0]).toMatchObject({ text: 'hello', runConfig: { writingVoiceId: 'news' } });
    expect(screen.queryByText('✎ News')).toBeNull();
    await type(input, 'again');
    await key(input, 'Enter');
    await act(async () => undefined);
    expect(runs[1]?.runConfig?.writingVoiceId).toBeUndefined();
  });

  it('keeps the voice for the chat with Tab, shows the footer chip and a transcript line', async () => {
    const { input } = await mount();
    await type(input, '/ne');
    await key(input, 'Tab');
    expect(setChat).toHaveBeenCalledWith('s1', 'news');
    expect(await screen.findByRole('button', { name: '✎ News' })).toBeTruthy();
    expect(screen.getByText('Writing in News from here')).toBeTruthy();
  });

  it("goes back to the agent's voice from the footer chip", async () => {
    chatVoice = { voiceId: 'news', voiceName: 'News', marks: [] };
    await mount();
    const chip = await screen.findByRole('button', { name: '✎ News' });
    openMenu(chip);
    await flushMenu();
    let menu = screen.getByRole('menu', { name: 'This chat writes in' });
    expect(within(menu).getByText('This chat writes in')).toBeTruthy();
    expect(within(menu).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      'News',
      'Plain working',
      "Use Marlow's voice",
    ]);
    expect(within(menu).getByRole('menuitemradio', { name: 'News' }).getAttribute('aria-checked')).toBe('true');
    expect(within(menu).getByRole('menuitem', { name: 'Manage voices…' })).toBeTruthy();
    // Escape closes it and puts focus back on the chip.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await flushMenu();
    expect(screen.queryByRole('menu', { name: 'This chat writes in' })).toBeNull();
    expect(document.activeElement).toBe(chip);
    openMenu(chip);
    await flushMenu();
    menu = screen.getByRole('menu', { name: 'This chat writes in' });
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: "Use Marlow's voice" }));
    });
    expect(setChat).toHaveBeenCalledWith('s1', null);
    expect(await screen.findByText("Back to Marlow's voice from here")).toBeTruthy();
  });

  it('leaves the text alone on Escape and sends slash text as typed', async () => {
    const { input, runs } = await mount();
    await type(input, '/ne');
    await key(input, 'Escape');
    expect(input.value).toBe('/ne');
    expect(screen.queryByRole('listbox', { name: 'Commands' })).toBeNull();
    await type(input, '/zzz');
    expect(screen.getByText('No voice called “zzz”. Esc sends it as text.')).toBeTruthy();
    await key(input, 'Escape');
    await key(input, 'Enter');
    await screen.findByText('ok');
    expect(runs[0]).toMatchObject({ text: '/zzz' });
    expect(runs[0].runConfig?.writingVoiceId).toBeUndefined();
  });

  it('does not open for a slash after other text', async () => {
    const { input } = await mount();
    await type(input, 'see /ne');
    expect(screen.queryByRole('listbox', { name: 'Commands' })).toBeNull();
  });

  it('removes the chip with Backspace at the start of the box', async () => {
    const { input } = await mount();
    await type(input, '/ne');
    await key(input, 'Enter');
    input.setSelectionRange(0, 0);
    await key(input, 'Backspace');
    expect(screen.queryByText('✎ News')).toBeNull();
  });

  it("keeps a queued chip message's voice when it drains", async () => {
    let release: () => void = () => undefined;
    const gate = { wait: new Promise<void>((r) => (release = r)) };
    const { input, runs } = await mount(gate);
    await type(input, 'first');
    await key(input, 'Enter');
    await type(input, '/ne');
    await key(input, 'Enter');
    await type(input, 'second');
    await key(input, 'Enter');
    await key(input, 'Enter');
    expect(screen.queryByText('✎ News')).toBeNull();
    await act(async () => release());
    await act(async () => undefined);
    await act(async () => undefined);
    expect(runs.map((r) => r.text)).toEqual(['first', 'second']);
    expect(runs[1].runConfig?.writingVoiceId).toBe('news');
  });

  it('drops the footer chip when its voice is deleted elsewhere', async () => {
    chatVoice = { voiceId: 'news', voiceName: 'News', marks: [] };
    await mount();
    expect(await screen.findByRole('button', { name: '✎ News' })).toBeTruthy();
    voicesNow = [voice('plain', 'Plain working')];
    chatVoice = { voiceId: null, voiceName: null, marks: [] };
    await act(async () => voicesChanged?.());
    await act(async () => undefined);
    expect(screen.queryByRole('button', { name: '✎ News' })).toBeNull();
  });

  it("leaves no run config behind for a retry to reuse", async () => {
    const { input } = await mount();
    await type(input, '/ne');
    await key(input, 'Enter');
    await type(input, 'hello');
    await key(input, 'Enter');
    await screen.findByText('ok');
    await act(async () => undefined);
    expect(probe.runConfig).toEqual({});
  });

  it('offers voices in a room and sends the chip with the message', async () => {
    const { input, runs } = await mount(undefined, true);
    await type(input, '/ne');
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeTruthy();
    await key(input, 'Enter');
    await type(input, '@Marlow hello');
    await key(input, 'Enter');
    await act(async () => undefined);
    expect(runs[0]?.runConfig?.writingVoiceId).toBe('news');
  });
});

