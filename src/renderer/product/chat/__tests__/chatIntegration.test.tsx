import React from 'react';
import { act, cleanup, configure, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeBridge,
  fakeHermesChat,
  settle,
  withIdleMain,
  type FakeBridge,
  type FakeHermesChat,
} from '../../../__tests__/fakeBridge';
import type { AgentProfile, ChannelRecord, HermesConversationKind } from '../../../../shared/types/hermesChat';

/**
 * The chat screen as the user meets it: the real assistant-ui runtime with the Hermes adapter,
 * the thread and its messages, against a fake bridge that plays main's side of a turn
 * (ADR 0031 §5). Each bug found by hand in the chat screen adds a case here.
 */

const noop = () => undefined;
globalThis.ResizeObserver ??= class {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
} as unknown as typeof ResizeObserver;
Element.prototype.scrollTo ??= noop;

// getByRole's default visibility check calls jsdom's getComputedStyle up every candidate's
// ancestors, which was half this file's CPU time and timed it out on a loaded machine. No
// stylesheet loads here; the one aria-hidden match, autosize's mirror, is `composer`'s to skip.
configure({ defaultHidden: true });

// Markdown rendering is out of scope; the reply's text is what is checked.
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

import { HermesChatRuntimeProvider } from '../HermesChatRuntimeProvider';
import { STOP_GUARD_MS, WorkbenchThread } from '../WorkbenchThread';
import { setRunningTurnsForTests } from '../runningTurns';

const SESSION = 's-1';

const ana: AgentProfile = {
  slug: 'ana',
  displayName: 'Ana',
  handle: 'Ana',
  role: 'Researcher',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const room: ChannelRecord = {
  id: 'ch-1',
  slug: 'research',
  title: 'research',
  sessionId: SESSION,
  memberSlugs: ['ana'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

let bridge: FakeBridge;
let chat: FakeHermesChat;

function installBridge() {
  bridge = createFakeBridge();
  chat = fakeHermesChat(bridge, SESSION);
  bridge.install(withIdleMain(bridge, { hermesChat: chat.leaves }));
}

async function renderChat(kind: HermesConversationKind) {
  render(
    <HermesChatRuntimeProvider sessionId={SESSION}>
      <WorkbenchThread
        sessionId={SESSION}
        threadTitle={kind === 'channel' ? '#research' : 'Ana'}
        kind={kind}
        agent={kind === 'dm' ? ana : null}
        channel={kind === 'channel' ? room : null}
        agents={[ana]}
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
  );
  await settle();
}

const composer = () => document.querySelector('textarea:not([aria-hidden])') as HTMLTextAreaElement;

/** Types `text` and sends it, then waits for main's answer to the start. */
async function send(text: string) {
  const input = composer();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    fireEvent.input(input);
  });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send message' })));
  await settle();
}

const replies = () => [...document.querySelectorAll('.wb-msg.is-assistant')] as HTMLElement[];

describe('chat screen against a fake bridge', () => {
  // The first mount in a worker costs about three times a later one (JIT, jsdom's default
  // stylesheet, Intl formatters). Paying that here keeps it out of the first case's budget,
  // where a starved worker timed out.
  beforeAll(async () => {
    vi.useFakeTimers();
    installBridge();
    await renderChat('dm');
    await send('warm up');
    await chat.finish();
    cleanup();
    setRunningTurnsForTests([]);
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    installBridge();
  });
  afterEach(async () => {
    await settle();
    cleanup();
    setRunningTurnsForTests([]);
    vi.useRealTimers();
    expect(bridge.unfaked).toEqual([]);
  });

  it('streams a sent message into one reply under the agent’s name', async () => {
    await renderChat('dm');
    await send('find the paper');
    expect(chat.startChat).toHaveBeenCalledTimes(1);

    await chat.stream('Here is ');
    await chat.stream('the paper.');
    await chat.finish();

    expect(screen.getByText('find the paper')).toBeTruthy();
    expect(replies()).toHaveLength(1);
    expect(within(replies()[0]).getByText('Ana')).toBeTruthy();
    expect(within(replies()[0]).getByText('Here is the paper.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
  });
  // Found by hand: a post that woke nobody left an empty reply from the default speaker
  // until the chat reloaded.
  it('leaves no reply under a channel post that wakes no agent', async () => {
    await renderChat('channel');
    chat.nextStart = { posted: true };
    await send('notes for later');

    expect(screen.getByText('notes for later')).toBeTruthy();
    expect(replies()).toHaveLength(0);
    expect(screen.queryByText('Hermes')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
  });

  it('shows Stopped by you with Continue after Stop', async () => {
    await renderChat('dm');
    await send('write the letter');
    await chat.stream('Dear Sam, I wanted to');
    // Stop ignores clicks right after a send (a double-click on Send).
    await act(async () => vi.advanceTimersByTime(STOP_GUARD_MS));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop response' })));
    await settle();

    expect(chat.cancelChat).toHaveBeenCalledWith({ requestId: chat.requestId(), reason: 'stopped' });
    expect(replies()).toHaveLength(1);
    expect(within(replies()[0]).getByText('Dear Sam, I wanted to')).toBeTruthy();
    expect(within(replies()[0]).getByText('Stopped by you')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeTruthy();
  });

  it('shows the Approval needed card when the agent asks, and sends the answer', async () => {
    await renderChat('dm');
    await send('clean the build folder');
    await chat.approval({
      rpcRequestId: 'rpc-1',
      approvalRequestId: 'ap-1',
      toolName: 'terminal',
      command: 'rm -r build',
      choices: ['once', 'deny'],
    });
    await settle();

    const card = screen.getByRole('alertdialog', { name: 'Approval needed · terminal' });
    expect(within(card).getByText('rm -r build')).toBeTruthy();
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: /Run/ })));
    await settle();

    expect(chat.respondApproval).toHaveBeenCalledWith({ rpcRequestId: 'rpc-1', choice: 'once' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
