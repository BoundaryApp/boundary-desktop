import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CircleChannel, CircleMessage, CirclesState, DirectConversation } from '../../../../shared/types/circles';
import { ME, circleMember, circleSnapshot } from '../../../__tests__/circleFixtures';
import { installElectronAPI, stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { CircleChatView } from '../../circles/useCircleChat';
import type { DirectChatView } from '../../circles/useDirectChat';

const MAYA = 'bb'.repeat(32);
const BOOK = 'b1'.repeat(32);
const GARDEN = 'c1'.repeat(32);
const ALLOT = 'a1'.repeat(32);

const members = [circleMember({ identity: ME, name: 'Ada', isMe: true }), circleMember({ identity: MAYA, name: 'Maya' })];
const circles = [
  circleSnapshot({ key: GARDEN, name: 'Garden club', members }),
  circleSnapshot({ key: BOOK, name: 'Book club', members }),
  circleSnapshot({ key: ALLOT, name: 'allotment', members }),
];
const channel = (id: string, name: string, unread = 0, mentioned = false): CircleChannel => ({ id, name, unread, mentioned });

const data = vi.hoisted(() => ({
  state: null as unknown as CirclesState,
  channels: {} as Record<string, CircleChannel[]>,
  directUnread: {} as Record<string, number>,
  conversations: [] as DirectConversation[],
  messages: {} as Record<string, CircleMessage[]>,
}));

const chatOf = (messages: CircleMessage[]): CircleChatView => ({
  messages,
  loading: false,
  more: false,
  error: null,
  goneCount: 0,
  loadOlder: vi.fn(async () => undefined),
  send: vi.fn(async () => null),
  edit: vi.fn(async () => null),
  remove: vi.fn(async () => null),
  react: vi.fn(async () => null),
  seen: 0,
  markRead: vi.fn(),
  typing: [],
  seenBy: {},
  notifyTyping: vi.fn(),
});

const direct: DirectChatView = {
  messages: [],
  loading: false,
  more: false,
  error: null,
  typing: false,
  loadOlder: async () => undefined,
  send: async () => null,
  edit: async () => null,
  remove: async () => ({ error: null, unsent: false }),
  notifyTyping: () => undefined,
  markRead: () => undefined,
};

vi.mock('../../circles/useCircles', () => ({ useCirclesState: () => data.state }));
vi.mock('../../circles/useCircleChat', async (actual) => ({
  ...(await actual<typeof import('../../circles/useCircleChat')>()),
  useCircleChannels: () => data.channels,
  useCircleChat: (key: string, id: string) => chatOf(data.messages[`${key}/${id}`] ?? []),
}));
vi.mock('../../circles/useDirectChat', async (actual) => ({
  ...(await actual<typeof import('../../circles/useDirectChat')>()),
  useDirectUnread: () => data.directUnread,
  useDirectConversations: () => data.conversations,
  useDirectChat: () => direct,
}));

import { CircleThread } from '../../chat/circle/CircleThread';
import { openCircle, resetCirclesOpenForTests, useCirclesOpen, circleChannel } from '../../circles/circlesNavigation';
import { resetCircleViewingForTests } from '../../circles/circleViewingRegistry';
import { CirclesPanelTab } from '../CirclesPanelTab';
import { resetDesktopPanelForTests } from '../desktopPanel';

let viewing: ReturnType<typeof vi.fn>;

function Destination() {
  const open = useCirclesOpen();
  return (
    <output aria-label="destination">
      {open.open?.kind === 'circle' ? open.open.key : 'none'}:{circleChannel(open, GARDEN)}
    </output>
  );
}

const show = () =>
  render(
    <>
      <CirclesPanelTab />
      <Destination />
    </>
  );
const list = () => screen.getByRole('group', { name: 'Circle list' });
const picker = () => screen.getByRole('combobox', { name: 'Conversation' }) as HTMLSelectElement;

beforeEach(() => {
  installElectronAPI();
  window.localStorage.clear();
  resetCirclesOpenForTests();
  resetCircleViewingForTests();
  resetDesktopPanelForTests();
  viewing = vi.fn().mockResolvedValue(undefined);
  stubElectronAPI({ circles: { viewing } });
  data.state = { status: 'running', displayName: 'Ada', snapshot: { identity: ME, circles }, providers: {}, sharing: { models: [], circles: [], paused: false, away: false } } as unknown as CirclesState;
  data.channels = {
    [GARDEN]: [channel('general', 'General'), channel('garden', 'Garden', 2)],
    [BOOK]: [channel('general', 'General', 3, true)],
    [ALLOT]: [channel('general', 'General')],
  };
  data.directUnread = { [GARDEN]: 1 };
  data.conversations = [];
  data.messages = {};
});

afterEach(cleanup);

describe('CirclesPanelTab (ADR 0058 §8, §13, §15)', () => {
  it('lists every Circle in name order, bold with its count and the mention mark', () => {
    show();
    const rows = within(list()).getAllByRole('button');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'allotment',
      'Book club, 3 unread, mentions you',
      'Garden club, 3 unread',
    ]);
    expect(rows[1].className).toContain('is-unread');
    expect(rows[0].className).not.toContain('is-unread');
  });

  it('offers no start, join, invite or row menu', () => {
    show();
    expect(screen.queryByRole('button', { name: 'Start or join a Circle' })).toBeNull();
    fireEvent.contextMenu(within(list()).getAllByRole('button')[0]);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(within(list()).getByRole('button', { name: 'allotment' }));
    expect(screen.queryByRole('button', { name: /Invite/ })).toBeNull();
  });

  it('opens the channel last open in that Circle, shared with the Circles screen', () => {
    act(() => openCircle(BOOK));
    act(() => openCircle(GARDEN, 'garden'));
    act(() => openCircle(BOOK));
    show();
    fireEvent.click(within(list()).getByRole('button', { name: /^Garden club/ }));
    expect(picker().value).toBe('garden');
    fireEvent.change(picker(), { target: { value: 'general' } });
    // The Circles screen keeps showing its own Circle, and opens Garden club on General next time.
    expect(screen.getByRole('status', { name: 'destination' }).textContent).toBe(`${BOOK}:general`);
  });

  it('remembers the Circle it showed', () => {
    const first = show();
    fireEvent.click(within(list()).getByRole('button', { name: /^Garden club/ }));
    first.unmount();
    resetDesktopPanelForTests();
    show();
    expect(picker()).toBeTruthy();
  });

  it('goes back to the list', () => {
    show();
    fireEvent.click(within(list()).getByRole('button', { name: /^Garden club/ }));
    fireEvent.click(screen.getByRole('button', { name: 'All Circles' }));
    expect(list()).toBeTruthy();
  });

  it('keeps the brand edge and says everyone gets a copy', () => {
    show();
    fireEvent.click(within(list()).getByRole('button', { name: /^Garden club/ }));
    expect(document.querySelector('.wb-circle-composer')).not.toBeNull();
    expect(screen.getByText('Everyone in Garden club gets a copy')).toBeTruthy();
    expect(screen.queryByText(/only you see this/)).toBeNull();
  });

  it('shows one draft for a channel open in both the panel and the Circles screen', () => {
    show();
    fireEvent.click(within(list()).getByRole('button', { name: /^Garden club/ }));
    render(
      <section aria-label="Screen">
        <CircleThread circle={circles[0]} channel={{ id: 'general', name: 'General' }} chat={chatOf([])} />
      </section>
    );
    const [inPanel, inScreen] = screen.getAllByRole('textbox', { name: 'Message Garden club' }) as HTMLTextAreaElement[];
    fireEvent.change(inPanel, { target: { value: 'see you at six' } });
    expect(inScreen.value).toBe('see you at six');
  });

  it('lists the Circle’s direct messages and opens one', () => {
    data.conversations = [
      { peer: MAYA, name: 'Maya', online: true, ended: false, last: null, waiting: 0, unread: 1 },
    ];
    show();
    fireEvent.click(within(list()).getByRole('button', { name: /^Garden club/ }));
    const options = within(picker()).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['General', 'Garden (2)', 'Maya (1)']);
    fireEvent.change(picker(), { target: { value: `dm:${MAYA}` } });
    expect(screen.getByRole('textbox', { name: 'Message Maya' })).toBeTruthy();
  });

  it('tells main the panel’s channel while the panel has focus, and nothing once it closes', () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { unmount } = show();
    fireEvent.click(within(list()).getByRole('button', { name: /^Garden club/ }));
    expect(viewing).toHaveBeenLastCalledWith({ circleKey: GARDEN, channel: 'general', focused: true });
    focused.mockReturnValue(false);
    fireEvent.blur(window);
    // Unfocused, the panel gives way to the window, which shows no channel here.
    expect(viewing).toHaveBeenLastCalledWith(null);
    unmount();
    expect(viewing).toHaveBeenLastCalledWith(null);
    focused.mockRestore();
  });

  it('shows the dock’s line when Circles can’t connect', () => {
    data.state = { ...data.state, status: 'failed', error: 'No network.' } as CirclesState;
    show();
    expect(screen.getByText(/Circles can’t connect: No network\./)).toBeTruthy();
  });
});
