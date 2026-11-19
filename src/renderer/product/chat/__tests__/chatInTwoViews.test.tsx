import React from 'react';
import { act, cleanup, configure, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeBridge,
  fakeHermesChat,
  settle,
  withIdleMain,
  type FakeBridge,
  type FakeHermesChat,
} from '../../../__tests__/fakeBridge';
import type { AgentProfile } from '../../../../shared/types/hermesChat';

/**
 * One agent chat open in two views at once, as Chat and the floating agent window will have it
 * (agent window spec, phase 1). Both views run the real runtime and thread under one
 * `ChatRuntimeHost`, against a fake bridge that plays main's side of a turn. Main sends a
 * turn's chunks to the window that started it, keyed by request id, so every view in that
 * window receives them; the fake does the same.
 */

const noop = (): void => undefined;

configure({ defaultHidden: true });

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

import { HermesChatRuntimeProvider } from '../HermesChatRuntimeProvider';
import { WorkbenchThread } from '../WorkbenchThread';
import { ChatRuntimeHost } from '../chatRuntimeHost';
import { resetChatDraftsForTests } from '../chatDrafts';
import { setRunningTurnsForTests } from '../runningTurns';
import { AgentChatPanel } from '../../agentPanel/AgentChatPanel';
import { resetPanelChatForTests } from '../../agentPanel/agentPanelChat';

const SESSION = 's-1';

const hob: AgentProfile = {
  slug: 'hermes',
  displayName: 'Marlow',
  handle: 'Marlow',
  role: 'Assistant',
  builtIn: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

let bridge: FakeBridge;
let chat: FakeHermesChat;

const View: React.FC<{ name: string }> = ({ name }) => (
  <section aria-label={name}>
    <HermesChatRuntimeProvider sessionId={SESSION}>
      <WorkbenchThread
        sessionId={SESSION}
        threadTitle="Marlow"
        kind="dm"
        agent={hob}
        agents={[hob]}
        activeProject={null}
        projects={[]}
        activeProjectId={null}
        toolsEnabled
        onToolsEnabledChange={noop}
        onSelectProject={noop}
        onClearProject={noop}
        onNewProject={noop}
      />
    </HermesChatRuntimeProvider>
  </section>
);

type Open = { chat: boolean; window: boolean };

const Views: React.FC<Open> = (open) => (
  <ChatRuntimeHost>
    {open.chat ? <View name="Chat" /> : null}
    {open.window ? <View name="Window" /> : null}
  </ChatRuntimeHost>
);

let rerender: (ui: React.ReactElement) => void;

async function show(open: Open) {
  if (rerender) {
    rerender(<Views {...open} />);
  } else {
    ({ rerender } = render(<Views {...open} />));
  }
  await settle();
}

const view = (name: string) => document.querySelector(`section[aria-label="${name}"]`) as HTMLElement;
const composerOf = (name: string) =>
  view(name).querySelector('textarea:not([aria-hidden])') as HTMLTextAreaElement;

async function type(name: string, text: string) {
  const input = composerOf(name);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    fireEvent.input(input);
  });
}

async function send(name: string, text: string) {
  await type(name, text);
  await act(async () =>
    fireEvent.click(within(view(name)).getByRole('button', { name: 'Send message' }))
  );
  await settle();
}

const replyText = (name: string) =>
  [...view(name).querySelectorAll('.wb-msg.is-assistant')].map((el) => el.textContent ?? '').join('\n');

describe('one agent chat in two views', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bridge = createFakeBridge();
    chat = fakeHermesChat(bridge, SESSION);
    bridge.install(withIdleMain(bridge, { hermesChat: chat.leaves }));
    resetChatDraftsForTests();
  });
  afterEach(async () => {
    await settle();
    cleanup();
    rerender = undefined as unknown as typeof rerender;
    setRunningTurnsForTests([]);
    vi.useRealTimers();
    expect(bridge.unfaked).toEqual([]);
  });

  it('shows a message sent in either view in both', async () => {
    await show({ chat: true, window: true });

    await send('Window', 'from the window');
    await chat.stream('Got it.');
    await chat.finish();
    await settle();

    for (const name of ['Chat', 'Window']) {
      expect(within(view(name)).getByText('from the window')).toBeTruthy();
      expect(replyText(name)).toContain('Got it.');
    }

    await send('Chat', 'and from Chat');
    await chat.stream('Noted.');
    await chat.finish();
    await settle();

    expect(within(view('Window')).getByText('and from Chat')).toBeTruthy();
    expect(replyText('Window')).toContain('Noted.');
    expect(chat.startChat).toHaveBeenCalledTimes(2);
  });

  it('streams a turn started in one view live in the other', async () => {
    await show({ chat: true, window: true });

    await send('Window', 'write a haiku');
    await chat.stream('Autumn ');
    await settle();
    expect(replyText('Chat')).toContain('Autumn');

    await chat.stream('moonlight');
    await settle();
    expect(replyText('Chat')).toContain('Autumn moonlight');

    await chat.finish();
    await settle();
    expect(replyText('Chat')).toContain('Autumn moonlight');
  });

  it('shows text streamed before the second view opened', async () => {
    await show({ chat: false, window: true });

    await send('Window', 'write a haiku');
    await chat.stream('Autumn ');
    await settle();

    await show({ chat: true, window: true });
    expect(replyText('Chat')).toContain('Autumn');

    await chat.stream('moonlight');
    await settle();
    expect(replyText('Chat')).toContain('Autumn moonlight');
    await chat.finish();
  });

  it('keeps the draft typed in one view for the other', async () => {
    await show({ chat: false, window: true });
    await type('Window', 'half a thought');

    await show({ chat: true, window: true });
    expect(composerOf('Chat').value).toBe('half a thought');

    // Opening the chat in Chat after closing the window (⤢) keeps it too.
    await show({ chat: false, window: false });
    await show({ chat: true, window: false });
    expect(composerOf('Chat').value).toBe('half a thought');
  });

  // Chat opened first, so assistant-ui would mount the thread under its provider; the host
  // keeps the thread when either view closes.
  it.each([
    ['Window', 'Chat'],
    ['Chat', 'Window'],
  ])('keeps the turn streaming in %s when %s closes', async (stays, closes) => {
    await show({ chat: true, window: true });

    await send('Window', 'write a haiku');
    await chat.stream('Autumn ');
    await settle();

    await show({ chat: stays === 'Chat', window: stays === 'Window' });
    expect(view(closes)).toBeNull();
    await chat.stream('moonlight');
    await chat.finish();
    await settle();

    expect(chat.cancelChat).not.toHaveBeenCalled();
    expect(replyText(stays)).toContain('Autumn moonlight');
    expect(within(view(stays)).getByText('write a haiku')).toBeTruthy();
  });

  it('keeps a turn running with no view open and shows it live when the chat reopens', async () => {
    await show({ chat: false, window: true });

    await send('Window', 'write a haiku');
    await chat.stream('Autumn ');
    await show({ chat: false, window: false });
    await chat.stream('moonlight ');
    await settle();

    await show({ chat: true, window: false });
    expect(replyText('Chat')).toContain('Autumn moonlight');
    await chat.stream('falls');
    await chat.finish();
    await settle();
    expect(replyText('Chat')).toContain('Autumn moonlight falls');
    expect(chat.cancelChat).not.toHaveBeenCalled();
  });

  // A bug found by hand: under the host, queueing a follow-up interrupted the running reply
  // and sent the follow-up at once (run-control spec 2.2).
  it('queues a follow-up typed while a reply runs, without interrupting it', async () => {
    await show({ chat: true, window: false });
    await send('Chat', 'who might succeed him?');
    await type('Chat', 'any chance he stays?');
    const enter = () => act(async () => fireEvent.keyDown(composerOf('Chat'), { key: 'Enter' }));
    await enter();
    await enter();
    await settle();

    expect(chat.cancelChat).not.toHaveBeenCalled();
    expect(chat.startChat).toHaveBeenCalledTimes(1);
    expect(view('Chat').querySelectorAll('.wb-qchip')).toHaveLength(1);

    await chat.stream('Three names.');
    await chat.finish();
    await settle();
    expect(chat.startChat).toHaveBeenCalledTimes(2);
    expect(chat.startChat.mock.calls[1][0]).toMatchObject({ queued: true });
    expect(chat.cancelChat).not.toHaveBeenCalled();
  });
});

// The desktop panel's Agent tab is one of the two views (ADR 0058 §7).
describe('one agent chat in Chat and the desktop panel', () => {
  const thread = { id: SESSION, title: 'Haiku', updatedAt: '2026-11-12T09:00:00.000Z', kind: 'hermes' as const, agentSlug: 'hermes', projectId: null as string | null };

  const Both: React.FC<{ panel: boolean }> = ({ panel }) => (
    <ChatRuntimeHost>
      <View name="Chat" />
      {panel ? (
        <section aria-label="Panel">
          <AgentChatPanel onExpand={noop} />
        </section>
      ) : null}
    </ChatRuntimeHost>
  );

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    resetPanelChatForTests();
    bridge = createFakeBridge();
    chat = fakeHermesChat(bridge, SESSION);
    bridge.install(
      withIdleMain(bridge, {
        hermesChat: {
          ...chat.leaves,
          listThreads: async () => ({ success: true, threads: [thread] }),
          onSessionsChanged: bridge.listen('hermes-chat:sessions-changed'),
        },
        agents: {
          list: async () => ({ success: true, agents: [hob], standingDmByAgent: {} }),
          onChanged: bridge.listen('hermes-agents:changed'),
        },
        projects: { list: async () => ({ success: true, projects: [], activeId: null }) },
      })
    );
    resetChatDraftsForTests();
  });
  afterEach(async () => {
    await settle();
    cleanup();
    rerender = undefined as unknown as typeof rerender;
    setRunningTurnsForTests([]);
    vi.useRealTimers();
    expect(bridge.unfaked).toEqual([]);
  });

  async function showBoth(panel: boolean) {
    if (rerender) rerender(<Both panel={panel} />);
    else ({ rerender } = render(<Both panel={panel} />));
    await settle();
  }

  it('shows a message sent in the panel in Chat, and the reverse', async () => {
    await showBoth(true);
    await send('Panel', 'from the panel');
    await chat.stream('Got it.');
    await chat.finish();
    await settle();
    expect(within(view('Chat')).getByText('from the panel')).toBeTruthy();
    expect(replyText('Chat')).toContain('Got it.');

    await send('Chat', 'and from Chat');
    await chat.stream('Noted.');
    await chat.finish();
    await settle();
    expect(within(view('Panel')).getByText('and from Chat')).toBeTruthy();
    expect(replyText('Panel')).toContain('Noted.');
  });

  it('keeps the panel’s draft for Chat once the panel closes, as ⤢ does', async () => {
    await showBoth(true);
    await type('Panel', 'half a thought');
    await showBoth(false);
    expect(composerOf('Chat').value).toBe('half a thought');
  });
});
