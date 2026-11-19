import React from 'react';
import { act, cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * The paced reveal of a streamed reply in the mounted chat screen: the real runtime and
 * thread against the fake bridge, with animation frames and the clock faked.
 */

const noop = (): void => undefined;

// getByRole's default visibility check calls getComputedStyle up every candidate's
// ancestors, which under jsdom was half this file's CPU time and timed it out on a loaded machine. No
// stylesheet loads here; the one aria-hidden match, autosize's mirror, is `composer`'s to skip.
configure({ defaultHidden: true });

// Markdown rendering is out of scope; the reply's text is what is checked.
vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

import { HostedChatRuntime } from './threadHarness';
import { WorkbenchThread } from '../WorkbenchThread';
import { setStreamPacingEnabled } from '../usePacedText';
import { END_DRAIN_MS } from '../streamPacer';
import { setRunningTurnsForTests } from '../runningTurns';

const SESSION = 's-1';

const ana: AgentProfile = {
  slug: 'ana',
  displayName: 'Ana',
  handle: 'Ana',
  role: 'Researcher',
  builtIn: false,
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
    <HostedChatRuntime sessionId={SESSION}>
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
    </HostedChatRuntime>
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

const replyText = () =>
  (document.querySelector('.wb-msg.is-assistant .wb-prose') as HTMLElement | null)?.textContent ?? '';

/** Let `ms` of animation frames run. */
async function frames(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe('paced reveal of a streamed reply', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
        'performance',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
    installBridge();
    setStreamPacingEnabled(true);
  });
  afterEach(async () => {
    await settle();
    cleanup();
    setRunningTurnsForTests([]);
    vi.useRealTimers();
    expect(bridge.unfaked).toEqual([]);
  });

  it('reveals a burst a word at a time and shows the rest soon after the end', async () => {
    await renderChat('dm');
    await send('find the paper');
    const full = 'Here is the paper you asked for, with the three sections it has.';

    await chat.stream('Here is the paper you asked for, ');
    await frames(16);
    // The first word shows at once; the rest of the burst is held back.
    expect(replyText()).toBe('Here ');

    await frames(200);
    const partway = replyText();
    expect(partway.length).toBeGreaterThan('Here '.length);
    expect(partway.length).toBeLessThan('Here is the paper you asked for, '.length);
    // Never part of a word while streaming.
    expect(partway.endsWith(' ')).toBe(true);

    await chat.stream('with the three sections it has.');
    await chat.finish();
    expect(replyText().length).toBeLessThan(full.length);
    await frames(END_DRAIN_MS + 50);
    expect(replyText()).toBe(full);
  });

  it('shows a reply whole when pacing is off', async () => {
    setStreamPacingEnabled(false);
    await renderChat('dm');
    await send('find the paper');
    await chat.stream('Here is the paper.');
    expect(replyText()).toBe('Here is the paper.');
    await chat.finish();
  });
});
