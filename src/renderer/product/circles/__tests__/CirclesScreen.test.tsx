import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CircleChatPresence,
  CircleChatUpdate,
  CircleMessage,
  CircleMessageRef,
  CirclesState,
} from '../../../../shared/types/circles';
import { CIRCLE_KEY as KEY, ME, circleMember, circleSnapshot, runningCircles } from '../../../__tests__/circleFixtures';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { clearChatScreenSnapshot } from '../../chat/chatScreenCache';

const MAYA = 'bb'.repeat(32);

const circle = circleSnapshot({
  name: 'Book club',
  members: [circleMember({ identity: ME, name: 'Ada', isMe: true }), circleMember({ identity: MAYA, name: 'Maya', role: 'admin' })],
});

const running = runningCircles({ circles: [circle] });

const message = (text: string, extra: Partial<CircleMessage> = {}): CircleMessage => ({
  circleKey: KEY,
  channel: 'general',
  author: MAYA,
  id: '0123456789abcdef',
  name: 'Maya',
  agent: null,
  text,
  at: Date.UTC(2026, 10, 3, 9, 12),
  confirmed: true,
  edited: false,
  deleted: null,
  shared: null,
  call: null,
  mentions: null,
  reply: null,
  reactions: [],
  mine: false,
  ...extra,
});

const chatListeners = new Set<(update: CircleChatUpdate) => void>();
const presenceListeners = new Set<(presence: CircleChatPresence) => void>();
const channelListeners = new Set<(event: { circleKey: string }) => void>();
const getState = vi.fn();
const chatAddChannel = vi.fn();
const chatMessages = vi.fn();
const chatChannels = vi.fn();
const chatPost = vi.fn();
const chatRead = vi.fn();
const createHermesChat = vi.fn();
const leave = vi.fn();
const deleteCircle = vi.fn();
const create = vi.fn();
const join = vi.fn();
const cancelJoin = vi.fn();
const setDisplayName = vi.fn();
const stateListeners = new Set<(state: CirclesState) => void>();
const removeMember = vi.fn();
const setRole = vi.fn();
const viewing = vi.fn();
const notifyPrefs = vi.fn();
const setNotifyPrefs = vi.fn();
const openListeners = new Set<(target: { circleKey: string; channel: string; ref: CircleMessageRef }) => void>();

stubElectronAPI({
  circles: {
    getState: (...args: unknown[]) => getState(...args),
    chatAddChannel: (...args: unknown[]) => chatAddChannel(...args),
    onChannelsChanged: (listener: (event: { circleKey: string }) => void) => {
      channelListeners.add(listener);
      return () => channelListeners.delete(listener);
    },
    onState: (listener: (state: CirclesState) => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    create: (...args: unknown[]) => create(...args),
    join: (...args: unknown[]) => join(...args),
    cancelJoin: (...args: unknown[]) => cancelJoin(...args),
    setDisplayName: (...args: unknown[]) => setDisplayName(...args),
    chatChannels: (...args: unknown[]) => chatChannels(...args),
    chatMessages: (...args: unknown[]) => chatMessages(...args),
    chatPost: (...args: unknown[]) => chatPost(...args),
    chatRead: (...args: unknown[]) => chatRead(...args),
    onChatEvent: (listener: (update: CircleChatUpdate) => void) => {
      chatListeners.add(listener);
      return () => chatListeners.delete(listener);
    },
    onChatPresence: (listener: (presence: CircleChatPresence) => void) => {
      presenceListeners.add(listener);
      return () => presenceListeners.delete(listener);
    },
    chatTyping: vi.fn(async () => undefined),
    viewing: (...args: unknown[]) => viewing(...args),
    notifyPrefs: (...args: unknown[]) => notifyPrefs(...args),
    setNotifyPrefs: (...args: unknown[]) => setNotifyPrefs(...args),
    onOpenMessage: (listener: (target: { circleKey: string; channel: string; ref: CircleMessageRef }) => void) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    leave: (...args: unknown[]) => leave(...args),
    delete: (...args: unknown[]) => deleteCircle(...args),
    removeMember: (...args: unknown[]) => removeMember(...args),
    setRole: (...args: unknown[]) => setRole(...args),
    inviteHints: vi.fn(async () => ({ success: true, hints: { inv1: 'yrb7' } })),
  },
  hermesChat: {
    listThreads: vi.fn(async () => ({ success: true, threads: [] })),
    createHermesChat: (...args: unknown[]) => createHermesChat(...args),
    listMentions: vi.fn(async () => ({ success: true, mentions: [], unseen: 0 })),
    listProjectMarks: vi.fn(async () => ({ success: true, marks: [] })),
  },
  projects: { list: vi.fn(async () => ({ success: true, projects: [], activeProjectId: null })) },
  agents: { list: vi.fn(async () => ({ success: true, agents: [], standingDmByAgent: {} })) },
  channels: { list: vi.fn(async () => ({ success: true, channels: [] })) },
});

const forgetHook = vi.hoisted(() => ({ run: null as ((key: string) => void) | null }));
vi.mock('../circlesNavigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../circlesNavigation')>();
  return {
    ...actual,
    forgetCircle: (key: string) => {
      forgetHook.run?.(key);
      actual.forgetCircle(key);
    },
  };
});

vi.mock('../../chat/HermesChatRuntimeProvider', () => ({
  HermesChatRuntimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../chat/WorkbenchThread', () => ({
  WorkbenchThread: ({
    threadTitle,
    onShareToCircle,
  }: {
    threadTitle: string;
    onShareToCircle?: (share: { text: string; role: 'user' | 'assistant'; model?: string }) => void;
  }) => (
    <div>
      hermes-thread:{threadTitle}
      {onShareToCircle ? (
        <button
          type="button"
          onClick={() => onShareToCircle({ text: 'The reply as Hermes wrote it', role: 'assistant', model: 'qwen3-8b' })}
        >
          Share to Circle…
        </button>
      ) : null}
    </div>
  ),
}));

import { WorkbenchChatScreen } from '../../chat/WorkbenchChatScreen';
import { CirclesScreen } from '../CirclesScreen';
import { CirclesRail } from '../CirclesRail';
import { AREA_MIN_PX, DOCK_DEFAULT_PX, DOCK_MIN_PX, ROW_PX } from '../dockHeight';
import { openCircle, resetCirclesOpenForTests, showJoiningPage } from '../circlesNavigation';
import { dispatchAppCommand, useAppCommand } from '../../useAppShortcuts';
import { useCircleNotificationClicks } from '../useCircleViewing';
import { flushMenu, openMenu } from '../../../__tests__/openMenu';
import { resetCallCheckForTests } from '../useCallCheck';

function emit(update: Partial<CircleChatUpdate>) {
  act(() => {
    for (const listener of chatListeners) {
      listener({ circleKey: KEY, channel: 'general', added: [], changed: [], gone: [], ...update });
    }
  });
}

const rail = () => screen.getAllByRole('complementary')[0];
const circlesRail = () => screen.getByRole('complementary', { name: 'Circles' });
/** The list's aside is replaced when a Circle opens, so each try looks it up again. */
const findInRail = (role: string, options: { name: string | RegExp }) =>
  waitFor(() => within(circlesRail()).getByRole(role, options));
const findAllInRail = (role: string, options: { name: string | RegExp }) =>
  waitFor(() => within(circlesRail()).getAllByRole(role, options));

function pushState(next: CirclesState) {
  act(() => {
    for (const listener of stateListeners) listener(next);
  });
}

/**
 * Stands in for the ready shell: Chat or Circles, switched by app commands, with the notification
 * click hook beside them.
 */
const Shell: React.FC<{ start?: 'chat' | 'circles' }> = ({ start = 'chat' }) => {
  const [view, setView] = useState(start);
  useAppCommand((command) => {
    if (command === 'go-chat') setView('chat');
    else if (command === 'go-circles') setView('circles');
  });
  useCircleNotificationClicks();
  return view === 'circles' ? <CirclesScreen /> : <WorkbenchChatScreen />;
};

function clickNotification(target: { circleKey: string; channel: string; ref: CircleMessageRef }) {
  act(() => {
    for (const listener of openListeners) listener(target);
  });
}

const empty = runningCircles({ circles: [] });

describe('the Circles destination', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetCirclesOpenForTests();
    clearChatScreenSnapshot();
    chatChannels.mockResolvedValue({
      success: true,
      state: running,
      channels: [
        { id: 'general', name: 'General', unread: 0 },
        { id: 'garden', name: 'Garden', unread: 3 },
      ],
    });
    chatMessages.mockResolvedValue({ success: true, state: running, messages: [message('Chapter 3 tonight?')], more: false });
    chatPost.mockResolvedValue({ success: true, state: running, id: 'fedcba9876543210' });
    chatRead.mockResolvedValue({ success: true, state: running });
    createHermesChat.mockReturnValue(new Promise(() => undefined));
    // Main doesn't answer preference reads unless a test says how.
    notifyPrefs.mockReturnValue(new Promise(() => undefined));
    getState.mockResolvedValue(running);
    leave.mockResolvedValue({ success: true, state: running });
    removeMember.mockResolvedValue({ success: true, state: running });
    setRole.mockResolvedValue({ success: true, state: running });
  });

  afterEach(() => {
    cleanup();
    // Drops answers a test gave a mock, back to the one it was made with; beforeEach sets the
    // defaults again. Clearing alone kept them for every later test.
    vi.resetAllMocks();
    chatListeners.clear();
    stateListeners.clear();
    openListeners.clear();
    presenceListeners.clear();
    channelListeners.clear();
    resetCallCheckForTests();
    vi.useRealTimers();
    forgetHook.run = null;
  });

  const CHOIR = 'dd'.repeat(32);
  const choir = circleSnapshot({ key: CHOIR, name: 'Choir', members: circle.members });
  const ATTIC = 'ee'.repeat(32);
  const attic = circleSnapshot({ key: ATTIC, name: 'Attic', members: circle.members });

  /** Book club has 3 unread in Garden; Choir has 2 with a mention; Attic is read. */
  function threeCircles() {
    const state = runningCircles({ circles: [circle, choir, attic] });
    getState.mockResolvedValue(state);
    chatChannels.mockImplementation(async ({ key }: { key: string }) => ({
      success: true,
      state,
      channels:
        key === KEY
          ? [
              { id: 'general', name: 'General', unread: 0, mentioned: false },
              { id: 'garden', name: 'Garden', unread: 3, mentioned: false },
            ]
          : key === CHOIR
            ? [{ id: 'general', name: 'General', unread: 2, mentioned: true }]
            : [{ id: 'general', name: 'General', unread: 0, mentioned: false }],
    }));
  }

  it('shows a member typing until 6 seconds after their last signal', async () => {
    openCircle(KEY);
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    vi.useFakeTimers();
    const typing = () =>
      act(() => {
        for (const listener of presenceListeners) listener({ circleKey: KEY, from: MAYA, channel: 'general', kind: 'typing' });
      });
    typing();
    expect(screen.getByText('Maya is typing…')).toBeTruthy();
    act(() => vi.advanceTimersByTime(5_000));
    typing();
    act(() => vi.advanceTimersByTime(5_999));
    expect(screen.getByText('Maya is typing…')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('Maya is typing…')).toBeNull();
  });

  it('leaves Chat to This Mac: its rail as it was, and no Circle anywhere', async () => {
    render(<WorkbenchChatScreen />);
    expect(await within(rail()).findByRole('button', { name: /Mentions/ })).toBeTruthy();
    expect(within(rail()).getByRole('button', { name: 'All chats' })).toBeTruthy();
    await waitFor(() => expect(chatChannels).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText('Book club')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Place:/ })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Circles' })).toBeNull();
  });

  const dockRows = () =>
    within(within(circlesRail()).getByRole('group', { name: 'Circle list' }))
      .getAllByRole('button')
      .filter((button) => button.classList.contains('wb-circles-row') && button.closest('.wb-circles-row-wrap'));
  const orderOf = () => dockRows().map((row) => row.querySelector('.wb-row-title')?.textContent);

  it('lists every Circle once, by name, bold when unread', async () => {
    threeCircles();
    openCircle(ATTIC);
    render(<CirclesScreen />);
    const [choirRow] = await findAllInRail('button', { name: 'Choir, 2 unread, mentions you' });
    expect(choirRow.querySelector('.wb-rail-count')?.textContent).toBe('@2');
    expect(dockRows().map((row) => row.getAttribute('aria-label'))).toEqual([
      'Attic',
      'Book club, 3 unread',
      'Choir, 2 unread, mentions you',
    ]);
    expect(dockRows().map((row) => row.classList.contains('is-unread'))).toEqual([false, true, true]);
    expect(dockRows()[0].getAttribute('aria-current')).toBe('true');
    expect(within(circlesRail()).queryByText('Unread')).toBeNull();
    expect(within(circlesRail()).queryByText('All Circles')).toBeNull();
  });

  it('keeps the dock’s order when a channel is read and when a message arrives', async () => {
    threeCircles();
    openCircle(KEY, 'garden');
    render(<CirclesScreen />);
    await findAllInRail('button', { name: 'Choir, 2 unread, mentions you' });
    const before = orderOf();
    expect(before).toEqual(['Attic', 'Book club', 'Choir']);
    const state = runningCircles({ circles: [circle, choir, attic] });
    chatChannels.mockImplementation(async ({ key }: { key: string }) => ({
      success: true,
      state,
      channels:
        key === KEY
          ? [
              { id: 'general', name: 'General', unread: 0, mentioned: false },
              { id: 'garden', name: 'Garden', unread: 0, mentioned: false },
            ]
          : key === CHOIR
            ? [{ id: 'general', name: 'General', unread: 0, mentioned: false }]
            : [{ id: 'general', name: 'General', unread: 1, mentioned: false }],
    }));
    act(() => {
      for (const listener of channelListeners) listener({ circleKey: CHOIR });
      for (const listener of channelListeners) listener({ circleKey: ATTIC });
    });
    await findInRail('button', { name: 'Attic, 1 unread' });
    expect(orderOf()).toEqual(before);
    expect(dockRows().map((row) => row.classList.contains('is-unread'))).toEqual([true, false, false]);
  });

  it('shows the open Circle in the Circle area, above the dock, and keeps the rail when switching', async () => {
    threeCircles();
    openCircle(KEY, 'garden');
    render(<CirclesScreen />);
    const area = await findInRail('group', { name: 'Book club channels, direct messages and folders' });
    const railBefore = circlesRail();
    expect(within(railBefore).getByRole('heading', { name: 'Book club' })).toBeTruthy();
    const dock = within(railBefore).getByRole('group', { name: 'Circle list' });
    expect(area.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dock).queryByRole('button', { name: 'Garden' })).toBeNull();
    fireEvent.click(await within(dock).findByRole('button', { name: 'Choir, 2 unread, mentions you' }));
    await findInRail('group', { name: 'Choir channels, direct messages and folders' });
    expect(circlesRail()).toBe(railBefore);
    expect(within(circlesRail()).getByRole('heading', { name: 'Choir' })).toBeTruthy();
  });

  it('shows only the joining header while a join waits, with every Circle in the dock and none selected', async () => {
    threeCircles();
    getState.mockResolvedValue({ ...runningCircles({ circles: [circle, choir, attic] }), join: { waiting: true } });
    showJoiningPage();
    render(<CirclesScreen />);
    expect(await findInRail('heading', { name: 'Joining a Circle…' })).toBeTruthy();
    expect(within(circlesRail()).queryByRole('group', { name: /channels, direct messages and folders/ })).toBeNull();
    await waitFor(() => expect(dockRows()).toHaveLength(3));
    expect(dockRows().some((row) => row.hasAttribute('aria-current'))).toBe(false);
    const joining = within(circlesRail()).getByRole('button', { name: 'Joining a Circle… Waiting for an admin' });
    expect(joining.classList.contains('is-on')).toBe(true);
    // The joining row scrolls with the Circles, ahead of them.
    const list = within(circlesRail()).getByRole('group', { name: 'Circle list' });
    expect(list.firstElementChild).toBe(joining);
  });

  it('opens each Circle with its sections scrolled to the top', async () => {
    threeCircles();
    openCircle(KEY);
    render(<CirclesScreen />);
    const area = await findInRail('group', { name: 'Book club channels, direct messages and folders' });
    // jsdom has no scrolling, so the element keeps what is set on it.
    let top = 0;
    Object.defineProperty(area, 'scrollTop', { get: () => top, set: (value: number) => (top = value), configurable: true });
    top = 120;
    fireEvent.click(await within(circlesRail()).findByRole('button', { name: 'Choir, 2 unread, mentions you' }));
    const next = await findInRail('group', { name: 'Choir channels, direct messages and folders' });
    expect(next).toBe(area);
    expect(top).toBe(0);
  });

  it('keeps the rail, and the dock’s search, across the joining page and back', async () => {
    threeCircles();
    openCircle(KEY);
    render(<CirclesScreen />);
    const search = (await findInRail('searchbox', { name: 'Search Circles' })) as HTMLInputElement;
    const railBefore = circlesRail();
    fireEvent.change(search, { target: { value: 'ic' } });
    expect(orderOf()).toEqual(['Attic']);
    pushState({ ...runningCircles({ circles: [circle, choir, attic] }), join: { waiting: true } });
    act(() => showJoiningPage());
    expect(within(circlesRail()).getByRole('heading', { name: 'Joining a Circle…' })).toBeTruthy();
    act(() => openCircle(KEY));
    await findInRail('group', { name: 'Book club channels, direct messages and folders' });
    expect(circlesRail()).toBe(railBefore);
    expect(within(circlesRail()).getByRole('searchbox', { name: 'Search Circles' })).toBe(search);
    expect(search.value).toBe('ic');
  });

  it('never draws the rail without a Circle area when the open Circle is left, while others remain', async () => {
    threeCircles();
    openCircle(CHOIR);
    render(<CirclesScreen />);
    await findInRail('group', { name: 'Choir channels, direct messages and folders' });
    // The screen forgets a missing Circle in an effect after the commit that first lacks it, so
    // this is the DOM that commit painted.
    const painted: { area: boolean; rows: number }[] = [];
    forgetHook.run = () => {
      painted.push({ area: Boolean(document.querySelector('.wb-circle-area')), rows: document.querySelectorAll('.wb-circles-row-wrap').length });
    };
    pushState(runningCircles({ circles: [circle, attic] }));
    expect(painted).toEqual([{ area: true, rows: 2 }]);
    await findInRail('group', { name: 'Attic channels, direct messages and folders' });
    expect(orderOf()).toEqual(['Attic', 'Book club']);
  });

  it('opens the header’s ⋯ menu with the same items as the row’s', async () => {
    threeCircles();
    openCircle(KEY);
    render(<CirclesScreen />);
    await findInRail('heading', { name: 'Book club' });
    const area = circlesRail().querySelector('.wb-circle-area') as HTMLElement;
    openMenu(within(area).getByRole('button', { name: 'More for Book club' }));
    await flushMenu();
    const menu = screen.getByRole('menu', { name: 'Book club' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Circle details',
      'Notifications',
      'Leave…',
    ]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Circle details' }));
    expect(await screen.findByRole('complementary', { name: 'Circle details' })).toBeTruthy();
  });

  it('finds a Circle by name, and says when none matches', async () => {
    threeCircles();
    render(<CirclesScreen />);
    const search = await findInRail('searchbox', { name: 'Search Circles' });
    await findAllInRail('button', { name: 'Choir, 2 unread, mentions you' });
    fireEvent.change(search, { target: { value: 'CHO' } });
    expect(dockRows().map((row) => row.getAttribute('aria-label'))).toEqual(['Choir, 2 unread, mentions you']);
    fireEvent.change(search, { target: { value: 'quilting' } });
    expect(within(circlesRail()).getByText('No Circle is called that.')).toBeTruthy();
  });

  describe('the unread chip', () => {
    const DRAMA = 'ff'.repeat(32);
    const MUSIC = '11'.repeat(32);
    const drama = circleSnapshot({ key: DRAMA, name: 'Drama', members: circle.members });
    const music = circleSnapshot({ key: MUSIC, name: 'Music', members: circle.members });
    const restores: (() => void)[] = [];
    const view = { top: 0, bottom: 100 };

    afterEach(() => {
      while (restores.length) restores.pop()?.();
    });

    /** Attic, Book club, Choir, Drama, Music by name; only the ones in `unread` have unread messages. */
    function fiveCircles(unread: string[], openElsewhere: string[] = []) {
      const state = runningCircles({ circles: [circle, choir, attic, drama, music] });
      getState.mockResolvedValue(state);
      chatChannels.mockImplementation(async ({ key }: { key: string }) => ({
        success: true,
        state,
        channels: [
          { id: 'general', name: 'General', unread: unread.includes(key) ? 2 : 0, mentioned: false },
          { id: 'garden', name: 'Garden', unread: openElsewhere.includes(key) ? 4 : 0, mentioned: false },
        ],
      }));
    }

    /** jsdom has no layout: the scroller shows `view`, and each row is ROW_PX tall, stacked by its index. */
    function stubLayout() {
      const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        let top = 0;
        let bottom = 0;
        if (this.classList.contains('wb-circles-dock-rows')) ({ top, bottom } = view);
        else if (this.classList.contains('wb-circles-row-wrap')) {
          const index = Array.from(this.parentElement?.children ?? []).indexOf(this);
          top = ROW_PX * index;
          bottom = ROW_PX * (index + 1);
        }
        return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) };
      });
      const scroll = vi.fn();
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: scroll, configurable: true, writable: true });
      restores.push(
        () => rect.mockRestore(),
        () => Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
      );
      return scroll;
    }
    const scroller = () => within(circlesRail()).getByRole('group', { name: 'Circle list' });

    it('shows how many unread Circles are below the dock’s view, and scrolls to the nearest', async () => {
      fiveCircles([DRAMA, MUSIC]);
      view.bottom = 100;
      const scrollIntoView = stubLayout();
      render(<CirclesScreen />);
      const chip = await findInRail('button', { name: '2 unread Circles below' });
      expect(chip.textContent).toBe('2 unread ↓');
      fireEvent.click(chip);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
      expect(scrollIntoView.mock.contexts[0]).toBe(scroller().querySelectorAll('.wb-circles-row-wrap')[3]);
    });

    it('scrolls without animation when the person prefers reduced motion', async () => {
      fiveCircles([DRAMA, MUSIC]);
      view.bottom = 100;
      const scrollIntoView = stubLayout();
      const matchMedia = vi.fn((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }));
      vi.stubGlobal('matchMedia', matchMedia);
      restores.push(() => vi.unstubAllGlobals());
      render(<CirclesScreen />);
      fireEvent.click(await findInRail('button', { name: '2 unread Circles below' }));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
    });

    it('hides the chip once no unread row is out of view', async () => {
      fiveCircles([DRAMA, MUSIC]);
      view.bottom = 100;
      stubLayout();
      render(<CirclesScreen />);
      await findInRail('button', { name: '2 unread Circles below' });
      view.bottom = 400;
      fireEvent.scroll(scroller());
      expect(within(circlesRail()).queryByRole('button', { name: /unread Circles? (below|above)/ })).toBeNull();
    });

    it('doesn’t count the open Circle', async () => {
      fiveCircles([DRAMA], [MUSIC]);
      view.bottom = 100;
      stubLayout();
      openCircle(MUSIC);
      render(<CirclesScreen />);
      const chip = await findInRail('button', { name: '1 unread Circle below' });
      expect(chip.textContent).toBe('1 unread ↓');
      const open = within(scroller()).getByRole('button', { name: 'Music' });
      expect(open.classList.contains('is-unread')).toBe(false);
    });

    it('counts only rows that match the search, in the same order', async () => {
      fiveCircles([]);
      view.bottom = 40;
      stubLayout();
      render(<CirclesScreen />);
      const search = await findInRail('searchbox', { name: 'Search Circles' });
      await findAllInRail('button', { name: 'Music' });
      fireEvent.change(search, { target: { value: 'ic' } });
      expect(orderOf()).toEqual(['Attic', 'Music']);
      fiveCircles([MUSIC]);
      act(() => {
        for (const listener of channelListeners) listener({ circleKey: MUSIC });
      });
      const chip = await findInRail('button', { name: '1 unread Circle below' });
      expect(chip.textContent).toBe('1 unread ↓');
      expect(orderOf()).toEqual(['Attic', 'Music']);
    });
  });

  it('opens the first Circle by name when none was chosen, without storing it', async () => {
    threeCircles();
    render(<CirclesScreen />);
    await findInRail('group', { name: 'Attic channels, direct messages and folders' });
    expect(JSON.parse(window.localStorage.getItem('boundary:chat-place') ?? 'null')).toBeNull();
    fireEvent.click((await findAllInRail('button', { name: 'Choir, 2 unread, mentions you' }))[0]);
    expect(await findInRail('group', { name: 'Choir channels, direct messages and folders' })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('boundary:chat-place') ?? 'null').place).toEqual({ kind: 'circle', key: CHOIR });
  });

  it('marks unread mentions with @ on a channel, and says so in its name', async () => {
    chatChannels.mockResolvedValue({
      success: true,
      state: running,
      channels: [
        { id: 'general', name: 'General', unread: 0, mentioned: false },
        { id: 'garden', name: 'Garden', unread: 3, mentioned: true },
      ],
    });
    openCircle(KEY);
    render(<CirclesScreen />);
    const garden = await findInRail('button', { name: 'Garden, 3 unread, mentions you' });
    expect(garden.querySelector('.wb-rail-count')?.textContent).toBe('@3');
  });

  it('drops @channel marks when @channel notifies me is turned off, without a new message', async () => {
    // Main's answers follow the stored switch: the rail's mark and the prefs read both change.
    let channelMentions = true;
    notifyPrefs.mockImplementation(async () => ({
      prefs: { level: 'default', channelMentions },
      resolved: 'all',
      people: 2,
      global: { enabled: true, showText: true },
    }));
    setNotifyPrefs.mockImplementation(async (input: { prefs: { channelMentions: boolean } }) => {
      channelMentions = input.prefs.channelMentions;
    });
    chatChannels.mockImplementation(async () => ({
      success: true,
      state: running,
      channels: [
        { id: 'general', name: 'General', unread: 0, mentioned: false },
        { id: 'garden', name: 'Garden', unread: 3, mentioned: channelMentions },
      ],
    }));
    chatMessages.mockResolvedValue({
      success: true,
      state: running,
      messages: [message('@channel meeting at seven', { mentions: { members: [], channel: true } })],
      more: false,
    });
    openCircle(KEY);
    render(<CirclesScreen />);
    const row = () => screen.getByText(/meeting at seven/).closest('.wb-circle-msg')!;
    await waitFor(() => expect(row().className).toContain('is-mentioned'));
    expect(await findInRail('button', { name: 'Garden, 3 unread, mentions you' })).toBeTruthy();
    const reads = chatChannels.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Circle details' }));
    fireEvent.click(await screen.findByRole('switch', { name: '@channel notifies me' }));

    await waitFor(() => expect(row().className).not.toContain('is-mentioned'));
    const garden = await findInRail('button', { name: 'Garden, 3 unread' });
    expect(garden.querySelector('.wb-rail-count')?.textContent).toBe('3');
    expect(chatChannels.mock.calls.length).toBeGreaterThan(reads);
  });

  it('shows only the Circle: its channels and the channel, with no people in the list and no Hermes controls', async () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<CirclesScreen />);

    expect(await screen.findByText('Chapter 3 tonight?')).toBeTruthy();
    expect(within(circlesRail()).getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page');
    expect(within(circlesRail()).getByRole('button', { name: 'Garden, 3 unread' })).toBeTruthy();
    expect(within(circlesRail()).queryByRole('button', { name: /^You/ })).toBeNull();
    expect(within(circlesRail()).queryByText('People')).toBeNull();
    expect(within(circlesRail()).queryByRole('button', { name: /Mentions/ })).toBeNull();
    expect(screen.queryByText(/hermes-thread/)).toBeNull();

    expect(screen.getByPlaceholderText('Message Book club · 2 people')).toBeTruthy();
    expect(screen.getByText('Everyone in Book club gets a copy')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Tools' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mention' })).toBeNull();
    // The panel starts closed, and the header's button opens it.
    expect(screen.queryByRole('complementary', { name: 'Circle details' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Circle details' }));
    expect(screen.getByRole('complementary', { name: 'Circle details' })).toBeTruthy();

    await waitFor(() => expect(chatRead).toHaveBeenCalledWith({
      key: KEY,
      channel: 'general',
      position: { author: MAYA, id: '0123456789abcdef', at: message('').at },
    }));
    focused.mockRestore();
  });

  it('gives admins channel controls and members none', async () => {
    openCircle(KEY);
    const { unmount } = render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Circle details' }));
    expect(screen.getByRole('complementary', { name: 'Circle details' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a channel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename General' })).toBeNull();
    unmount();

    const admin = { ...circle, myRole: 'admin' as const };
    getState.mockResolvedValue(runningCircles({ circles: [admin] }));
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Circle details' }));
    const tab = screen.getByRole('complementary', { name: 'Circle details' });
    expect(within(tab).getByRole('button', { name: 'Rename General' })).toBeTruthy();
    expect(within(tab).queryByRole('button', { name: 'Remove General' })).toBeNull();
    expect(within(tab).getByRole('button', { name: 'Remove Garden' })).toBeTruthy();
  });

  it('lets only admins select messages to remove, and stops selecting on another channel', async () => {
    openCircle(KEY);
    const { unmount } = render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Circle details' }));
    expect(screen.queryByRole('button', { name: 'Remove messages' })).toBeNull();
    unmount();

    getState.mockResolvedValue(runningCircles({ circles: [{ ...circle, myRole: 'admin' as const }] }));
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Circle details' }));
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Circle details' })).getByRole('button', { name: 'Remove messages' }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(within(circlesRail()).getByRole('button', { name: /^Garden/ }));
    await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull());
  });

  it('opens a person from a who-line, with what they share and a link to Inference', async () => {
    const offers = [{ identity: MAYA, name: 'Maya', isMine: false, online: true, available: true, away: false, models: [{ id: 'qwen3-32b' }] }];
    getState.mockResolvedValue({ ...running, snapshot: { identity: ME, circles: [{ ...circle, offers }] } });
    const opened = vi.fn();
    window.addEventListener('boundary:open-inference', opened);
    openCircle(KEY);
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');

    fireEvent.click(screen.getByRole('button', { name: 'Maya' }));
    const panel = screen.getByRole('complementary', { name: 'Maya' });
    expect(within(panel).getByText('Online · Admin in Book club')).toBeTruthy();
    expect(within(panel).getByText('qwen3-32b')).toBeTruthy();
    // A member gets no membership actions.
    expect(within(panel).queryByRole('button', { name: 'Make member' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Open in Inference' }));
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ person: MAYA });
    window.removeEventListener('boundary:open-inference', opened);

    fireEvent.click(within(panel).getByRole('button', { name: 'Back to Book club' }));
    expect(screen.getByRole('complementary', { name: 'Circle details' })).toBeTruthy();
  });

  it('lets an admin change a person’s role and remove them, after asking', async () => {
    const admin = {
      ...circle,
      myRole: 'admin' as const,
      members: [circle.members[0], { ...circle.members[1], role: 'member' as const }],
    };
    getState.mockResolvedValue(runningCircles({ circles: [admin] }));
    openCircle(KEY);
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');

    fireEvent.click(screen.getByRole('button', { name: 'Maya' }));
    const panel = screen.getByRole('complementary', { name: 'Maya' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Make admin' }));
    await waitFor(() => expect(setRole).toHaveBeenCalledWith({ key: KEY, identity: MAYA, role: 'admin' }));

    fireEvent.click(within(panel).getByRole('button', { name: 'Remove from Book club' }));
    const sheet = screen.getByRole('dialog', { name: 'Remove Maya from Book club?' });
    expect(removeMember).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith({ key: KEY, identity: MAYA }));
  });

  it('shows an admin the open invites, and opens the invite sheet from the tab', async () => {
    const invites = [
      { id: 'inv1', expires: Date.now() + 3 * 24 * 60 * 60_000, revoked: false, used: false },
      { id: 'inv2', expires: Date.now() - 1, revoked: false, used: false },
    ];
    getState.mockResolvedValue(
      runningCircles({ inviteLabels: { inv1: 'Priya' }, inviteCodeIds: ['inv1'], circles: [{ ...circle, myRole: 'admin', invites }] })
    );
    openCircle(KEY);
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');

    fireEvent.click(screen.getByRole('button', { name: 'Circle details' }));
    const tab = screen.getByRole('complementary', { name: 'Circle details' });
    fireEvent.click(within(tab).getByRole('button', { name: 'Invite someone' }));
    expect(screen.getByRole('dialog', { name: 'Invite to Book club' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    const open = within(tab).getByRole('list', { name: 'Open invites' });
    await within(open).findByText('For Priya · yrb7…');
    expect(within(open).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(within(open).getByRole('button'));
    expect(screen.getByRole('dialog', { name: 'Invite to Book club' })).toBeTruthy();
  });

  it('leaves the Circle from the tab’s foot after asking, and offers Delete to its last member', async () => {
    openCircle(KEY);
    const { unmount } = render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Circle details' }));
    // Members get no invite controls.
    expect(screen.queryByRole('button', { name: 'Invite someone' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Leave Book club' }));
    const sheet = screen.getByRole('dialog', { name: 'Leave Book club?' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith({ key: KEY }));
    unmount();

    getState.mockResolvedValue(runningCircles({ circles: [{ ...circle, myRole: 'admin', members: [circle.members[0]] }] }));
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Circle details' }));
    expect(screen.queryByRole('button', { name: 'Leave Book club' })).toBeNull();
    deleteCircle.mockResolvedValue({ success: true, state: running });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Book club' }));
    const deleting = screen.getByRole('dialog', { name: 'Delete Book club?' });
    expect(within(deleting).getByText(/you can’t get it back/)).toBeTruthy();
    fireEvent.click(within(deleting).getByRole('button', { name: 'Delete Circle' }));
    await waitFor(() => expect(deleteCircle).toHaveBeenCalledWith({ key: KEY }));
  });

  it('says a leave finishes once an admin is online, and lists it until then', async () => {
    const left: CirclesState = { ...running, snapshot: { identity: ME, circles: [], leaving: [{ key: KEY, name: 'Book club' }] } };
    leave.mockResolvedValue({ success: true, state: left });
    openCircle(KEY);
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Circle details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave Book club' }));
    const sheet = screen.getByRole('dialog', { name: 'Leave Book club?' });
    expect(within(sheet).getByText(/If no admin is online, the leave finishes the next time one is/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith({ key: KEY }));
    pushState(left);
    const note = await waitFor(() => within(circlesRail()).getByRole('note'));
    expect(note.textContent).toMatch(/Leaving Book clubFinishes when an admin is online/);
    pushState({ ...left, snapshot: { ...left.snapshot!, leaving: undefined } });
    expect(within(circlesRail()).queryByRole('note')).toBeNull();
  });

  describe('a Circle row’s ⋯ menu', () => {
    /** The row's ⋯ in the dock; the open Circle's header has its own. */
    const openRowMenu = async (name: string) => {
      const more = await waitFor(() =>
        within(within(circlesRail()).getByRole('group', { name: 'Circle list' })).getByRole('button', {
          name: `More for ${name}`,
        })
      );
      openMenu(more);
      await flushMenu();
      return screen.getByRole('menu', { name });
    };
    const items = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((item) => item.textContent);
    const prefs = (level: string) => ({
      prefs: { level, channelMentions: true },
      resolved: 'all',
      people: 2,
      global: { enabled: true, showText: true },
    });

    it('offers members details, notifications and leave, and admins an invite that needs a writable Circle', async () => {
      threeCircles();
      openCircle(ATTIC);
      const { unmount } = render(<CirclesScreen />);
      expect(items(await openRowMenu('Book club'))).toEqual(['Circle details', 'Notifications', 'Leave…']);
      unmount();

      const state = runningCircles({
        circles: [
          { ...circle, myRole: 'admin' },
          { ...choir, myRole: 'admin', writable: false },
          attic,
        ],
      });
      getState.mockResolvedValue(state);
      render(<CirclesScreen />);
      const admin = await openRowMenu('Book club');
      expect(items(admin)).toEqual(['Invite someone…', 'Circle details', 'Notifications', 'Leave…']);
      expect(within(admin).getByRole('menuitem', { name: 'Invite someone…' }).getAttribute('aria-disabled')).toBeNull();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await flushMenu();
      const readOnly = await openRowMenu('Choir');
      expect(within(readOnly).getByRole('menuitem', { name: 'Invite someone…' }).getAttribute('aria-disabled')).toBe('true');
      expect(within(readOnly).getByRole('menuitem', { name: 'Leave…' }).getAttribute('aria-disabled')).toBe('true');
    });

    it('opens another Circle at the invite sheet, the Circle tab and the leave sheet, as the tab’s controls do', async () => {
      threeCircles();
      getState.mockResolvedValue(runningCircles({ circles: [{ ...circle, myRole: 'admin' }, choir, attic] }));
      openCircle(ATTIC);
      render(<CirclesScreen />);

      fireEvent.click(within(await openRowMenu('Book club')).getByRole('menuitem', { name: 'Invite someone…' }));
      expect(await screen.findByRole('dialog', { name: 'Invite to Book club' })).toBeTruthy();
      expect(within(circlesRail()).getAllByRole('button', { name: 'Book club' })[0].getAttribute('aria-current')).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));

      openCircle(ATTIC);
      fireEvent.click(within(await openRowMenu('Choir')).getByRole('menuitem', { name: 'Circle details' }));
      const tab = await screen.findByRole('complementary', { name: 'Circle details' });
      expect(within(tab).getByText('Choir')).toBeTruthy();
      expect(within(circlesRail()).getAllByRole('button', { name: 'Choir' })[0].getAttribute('aria-current')).toBe('true');

      openCircle(ATTIC);
      fireEvent.click(within(await openRowMenu('Book club')).getByRole('menuitem', { name: 'Leave…' }));
      const sheet = await screen.findByRole('dialog', { name: 'Leave Book club?' });
      fireEvent.click(within(sheet).getByRole('button', { name: 'Leave' }));
      await waitFor(() => expect(leave).toHaveBeenCalledWith({ key: KEY }));
    });

    it('opens the same sheets and tab on the Circle that is already open', async () => {
      getState.mockResolvedValue(runningCircles({ circles: [{ ...circle, myRole: 'admin' }] }));
      openCircle(KEY);
      render(<CirclesScreen />);
      await screen.findByText('Chapter 3 tonight?');

      fireEvent.click(within(await openRowMenu('Book club')).getByRole('menuitem', { name: 'Circle details' }));
      const tab = await screen.findByRole('complementary', { name: 'Circle details' });
      fireEvent.click(within(tab).getByRole('button', { name: 'Close Circle details' }));

      fireEvent.click(within(await openRowMenu('Book club')).getByRole('menuitem', { name: 'Invite someone…' }));
      expect(await screen.findByRole('dialog', { name: 'Invite to Book club' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));

      fireEvent.click(within(await openRowMenu('Book club')).getByRole('menuitem', { name: 'Leave…' }));
      expect(await screen.findByRole('dialog', { name: 'Leave Book club?' })).toBeTruthy();
    });

    it('offers Delete to a Circle’s last member, as the tab does', async () => {
      getState.mockResolvedValue(runningCircles({ circles: [{ ...circle, myRole: 'admin', members: [circle.members[0]] }] }));
      openCircle(KEY);
      render(<CirclesScreen />);
      fireEvent.click(within(await openRowMenu('Book club')).getByRole('menuitem', { name: 'Delete Circle…' }));
      expect(await screen.findByRole('dialog', { name: 'Delete Book club?' })).toBeTruthy();
    });

    it('reads and saves the notification level the Circle tab shows', async () => {
      threeCircles();
      notifyPrefs.mockResolvedValue(prefs('default'));
      setNotifyPrefs.mockResolvedValue(undefined);
      openCircle(ATTIC);
      render(<CirclesScreen />);
      const menu = await openRowMenu('Choir');
      const notifications = await within(menu).findByRole('menuitem', { name: 'Notifications Default' });
      expect(notifyPrefs).toHaveBeenCalledWith({ key: CHOIR });
      fireEvent.click(notifications);
      await flushMenu();
      const levels = within(menu).getByRole('menu', { name: 'Notifications Default' });
      expect(within(levels).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
        'Default',
        'All',
        'Mentions',
        'Nothing',
      ]);
      expect(within(levels).getByRole('menuitemradio', { name: 'Default' }).getAttribute('aria-checked')).toBe('true');
      fireEvent.click(within(levels).getByRole('menuitemradio', { name: 'Mentions' }));
      await waitFor(() =>
        expect(setNotifyPrefs).toHaveBeenCalledWith({ key: CHOIR, prefs: { level: 'mentions', channelMentions: true } })
      );
      expect(screen.queryByRole('menu', { name: 'Choir' })).toBeNull();
    });

    it('opens from the row’s context menu, and Escape closes it with focus back on ⋯', async () => {
      threeCircles();
      openCircle(ATTIC);
      render(<CirclesScreen />);
      const [row] = await findAllInRail('button', { name: 'Choir, 2 unread, mentions you' });
      fireEvent.contextMenu(row);
      const menu = screen.getByRole('menu', { name: 'Choir' });
      await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      expect(screen.queryByRole('menu', { name: 'Choir' })).toBeNull();
      const more = row.parentElement?.querySelector('.wb-circles-row-more');
      await waitFor(() => expect(document.activeElement).toBe(more));
    });
  });

  it('explains Circles when there are none, and starts one from the list', async () => {
    getState.mockResolvedValue(empty);
    create.mockResolvedValue({ success: true, state: empty, key: KEY });
    render(<CirclesScreen />);
    expect(await screen.findByRole('heading', { name: 'Talk with the people you choose' })).toBeTruthy();
    expect(within(circlesRail()).getByText(/A Circle is a small invite-only group/)).toBeTruthy();
    expect(within(circlesRail()).queryByRole('searchbox')).toBeNull();
    expect(within(circlesRail()).queryByText('All Circles')).toBeNull();

    openMenu(within(circlesRail()).getByRole('button', { name: 'Start or join a Circle' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start a Circle…' }));
    const sheet = screen.getByRole('dialog', { name: 'Start a Circle' });
    // The user has a name, so the sheet doesn't ask for one.
    expect(within(sheet).queryByLabelText(/Your name in Circles/)).toBeNull();
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Book club' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'Book club' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start a Circle' })).toBeNull());
    // The new Circle reaches the state after create returns; it opens once it does.
    pushState(running);
    expect(await screen.findByText('Chapter 3 tonight?')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('boundary:chat-place') ?? 'null').place).toEqual({ kind: 'circle', key: KEY });
  });

  it('asks for the user’s name first when they have none', async () => {
    getState.mockResolvedValue({ ...empty, status: 'stopped', displayName: '' });
    setDisplayName.mockResolvedValue({ success: true, state: empty });
    create.mockResolvedValue({ success: true, state: empty, key: KEY });
    render(<CirclesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start a Circle…' }));
    const sheet = screen.getByRole('dialog', { name: 'Start a Circle' });
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Book club' } });
    const createButton = within(sheet).getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText(/Your name in Circles/), { target: { value: 'Ada' } });
    fireEvent.click(createButton);
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'Book club' }));
    expect(setDisplayName).toHaveBeenCalledWith({ name: 'Ada' });
    expect(setDisplayName.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
  });

  it('joins with a code: the waiting page, the Joining row, and the Circle once let in', async () => {
    getState.mockResolvedValue(empty);
    join.mockReturnValue(new Promise(() => undefined));
    const { unmount } = render(<CirclesScreen />);
    openMenu(await findInRail('button', { name: 'Start or join a Circle' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Join with an invite…' }));
    const sheet = screen.getByRole('dialog', { name: 'Join with an invite' });
    fireEvent.change(within(sheet).getByLabelText('Invite code'), { target: { value: ' yrb7ei1ng ' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Join' }));
    expect(join).toHaveBeenCalledWith({ code: 'yrb7ei1ng' });

    // Main marks the join as waiting when it starts, and the page shows.
    pushState({ ...empty, join: { waiting: true } });
    expect(screen.getByText('Waiting for an admin to let you in')).toBeTruthy();
    const joining = within(circlesRail()).getByRole('button', { name: 'Joining a Circle… Waiting for an admin' });
    expect(joining.getAttribute('aria-current')).toBe('true');

    // Leaving the destination and coming back keeps the page.
    unmount();
    getState.mockResolvedValue({ ...empty, join: { waiting: true } });
    render(<CirclesScreen />);
    expect(await screen.findByText('Waiting for an admin to let you in')).toBeTruthy();

    // Let in: the Circle replaces the row and the page moves into it.
    pushState({ ...running, join: null, finishingJoin: KEY });
    expect(await screen.findByText('Chapter 3 tonight?')).toBeTruthy();
    expect(within(circlesRail()).queryByRole('button', { name: /^Joining a Circle/ })).toBeNull();
  });

  it('shows a failed join on its page and closes the page when dismissed', async () => {
    getState.mockResolvedValue({ ...empty, join: { waiting: false, error: 'That invite has been used.' } });
    cancelJoin.mockResolvedValue({ success: true, state: empty });
    render(<CirclesScreen />);
    fireEvent.click(await findInRail('button', { name: 'Joining a Circle… Couldn’t join' }));
    expect(screen.getByText('The invite didn’t work')).toBeTruthy();
    expect(screen.getByText('That invite has been used.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(cancelJoin).toHaveBeenCalled());
    pushState(empty);
    expect(await screen.findByRole('heading', { name: 'Talk with the people you choose' })).toBeTruthy();
    expect(screen.queryByText('The invite didn’t work')).toBeNull();
  });

  it('says in the list when Circles can’t connect', async () => {
    getState.mockResolvedValue({ ...empty, status: 'failed', error: 'The network process stopped.' });
    render(<CirclesScreen />);
    expect(await screen.findByText(/Circles can’t connect: The network process stopped\./)).toBeTruthy();
    const opened = vi.fn();
    window.addEventListener('boundary:open-settings', opened);
    fireEvent.click(screen.getByRole('button', { name: 'Circles profile' }));
    window.removeEventListener('boundary:open-settings', opened);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'general' });
  });

  it('adds a channel from the list and opens it', async () => {
    getState.mockResolvedValue(runningCircles({ circles: [{ ...circle, myRole: 'admin' }] }));
    chatAddChannel.mockResolvedValue({ success: true, state: running, id: 'picks-a1b2c3' });
    openCircle(KEY);
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(within(circlesRail()).getByRole('button', { name: 'Add a channel' }));
    fireEvent.change(screen.getByPlaceholderText('Channel name'), { target: { value: 'Picks' } });
    chatChannels.mockResolvedValue({
      success: true,
      state: running,
      channels: [
        { id: 'general', name: 'General', unread: 0 },
        { id: 'picks-a1b2c3', name: 'Picks', unread: 0 },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(chatAddChannel).toHaveBeenCalledWith({ key: KEY, name: 'Picks' }));
    act(() => {
      for (const listener of channelListeners) listener({ circleKey: KEY });
    });
    await waitFor(() =>
      expect(within(circlesRail()).getByRole('button', { name: 'Picks' }).getAttribute('aria-current')).toBe('page')
    );
  });

  it('reopens the Circle on the channel last open there', async () => {
    openCircle(KEY, 'garden');
    render(<CirclesScreen />);
    await waitFor(() =>
      expect(within(circlesRail()).getByRole('button', { name: 'Garden' }).getAttribute('aria-current')).toBe('page')
    );
    expect(chatMessages).toHaveBeenLastCalledWith({ key: KEY, channel: 'garden', limit: 50 });
  });

  it('adds a message from a chat event, and sends what the user types', async () => {
    openCircle(KEY);
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    emit({ added: [message('Yes, 7pm', { id: '1111111111111111', confirmed: false })] });
    expect(screen.getByText('Yes, 7pm')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Waiting for admins to confirm/ })).toBeTruthy();

    const box = screen.getByRole('textbox', { name: 'Message Book club' });
    fireEvent.change(box, { target: { value: 'See you there' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(chatPost).toHaveBeenCalledWith({ key: KEY, channel: 'general', text: 'See you there', picked: [], mentionChannel: false }));
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  describe('sharing from a Hermes chat', () => {
    it('posts exactly the text in the box, marked as shared, and opens the channel on Circles from the toast', async () => {
      render(<Shell />);
      fireEvent.click(await screen.findByRole('button', { name: 'Share to Circle…' }));
      const box = screen.getByRole('textbox', { name: 'Text to share' }) as HTMLTextAreaElement;
      expect(box.value).toBe('The reply as Hermes wrote it');
      expect(screen.getByText('Shows as: Shared from a chat · reply from qwen3-8b')).toBeTruthy();
      expect(screen.getByText('Everyone in this Circle gets a copy that you can’t take back.')).toBeTruthy();
      fireEvent.change(screen.getByRole('combobox', { name: 'Channel' }), { target: { value: 'garden' } });
      fireEvent.change(box, { target: { value: 'Only this part' } });
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));

      await waitFor(() =>
        expect(chatPost).toHaveBeenCalledWith({
          key: KEY,
          channel: 'garden',
          text: 'Only this part',
          shared: { role: 'assistant', model: 'qwen3-8b' },
        })
      );
      expect(chatPost).toHaveBeenCalledTimes(1);
      const toast = await screen.findByText('Shared to Book club · Garden');
      expect(screen.queryByRole('complementary', { name: 'Circles' })).toBeNull();
      fireEvent.click(within(toast).getByRole('button', { name: 'Open' }));
      await waitFor(() =>
        expect(within(circlesRail()).getByRole('button', { name: 'Garden' }).getAttribute('aria-current')).toBe('page')
      );
    });

    it('sends nothing on cancel', async () => {
      render(<WorkbenchChatScreen />);
      fireEvent.click(await screen.findByRole('button', { name: 'Share to Circle…' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('textbox', { name: 'Text to share' })).toBeNull();
      expect(chatPost).not.toHaveBeenCalled();
    });

    it('isn’t offered to someone in no Circle', async () => {
      getState.mockResolvedValue(runningCircles({ circles: [] }));
      render(<WorkbenchChatScreen />);
      await screen.findByText(/hermes-thread/);
      expect(screen.queryByRole('button', { name: 'Share to Circle…' })).toBeNull();
    });
  });

  it('offers the call check only while it is on', async () => {
    vi.mocked(window.electronAPI.circles.callCheckEnabled).mockResolvedValueOnce(false);
    openCircle(KEY);
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Circle details' }));
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Call check…' })).toBeNull();
  });

  it('runs the call check against a member and logs metadata for each mode', async () => {
    const circles = vi.mocked(window.electronAPI.circles);
    circles.callCheckEnabled.mockResolvedValueOnce(true);
    circles.callSignalSend.mockResolvedValue(true);
    circles.callCheckResult.mockImplementation(async ({ result }) => result);
    openCircle(KEY);
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Circle details' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Call check…' }));
    expect(screen.getByRole('combobox', { name: 'Member' })).toHaveProperty('value', MAYA);
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    // The test DOM has no WebRTC, so every connection fails before an offer goes out.
    const table = await screen.findByRole('table', { name: 'Call check results' });
    await waitFor(() => expect(within(table).getAllByText('Failed at error')).toHaveLength(5));
    expect(circles.callCheckResult.mock.calls.map(([{ key, to }]) => [key, to])).toEqual(Array(5).fill([KEY, MAYA]));
    expect(circles.callCheckResult.mock.calls.map(([{ result }]) => [result.mode, result.role, result.failedAt])).toEqual([
      ['host', 'caller', 'error'],
      ['stun', 'caller', 'error'],
      ['swarm', 'caller', 'error'],
      ['tunnel', 'caller', 'error'],
      ['stun+tunnel', 'caller', 'error'],
    ]);
    for (const [{ result }] of circles.callCheckResult.mock.calls) {
      expect(Object.keys(result).sort()).toEqual(['connected', 'failedAt', 'kind', 'mode', 'role', 'run']);
    }
    circles.callSignalSend.mockReset();
    circles.callCheckResult.mockReset();
  });

  it('tells main which Circle channel is open, and clears it on going to Chat', async () => {
    openCircle(KEY);
    render(<Shell start="circles" />);
    await screen.findByText('Chapter 3 tonight?');
    expect(viewing).toHaveBeenCalledWith({ circleKey: KEY, channel: 'general', focused: document.hasFocus() });
    viewing.mockClear();
    act(() => dispatchAppCommand('go-chat'));
    await within(rail()).findByRole('button', { name: /Mentions/ });
    expect(viewing).toHaveBeenLastCalledWith(null);
  });

  it('opens Circles at the Circle, channel and message of a clicked notification', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    chatMessages.mockResolvedValue({
      success: true,
      state: running,
      messages: [message('Garden plans', { channel: 'garden' })],
      more: false,
    });
    render(<Shell />);
    await within(rail()).findByRole('button', { name: /Mentions/ });
    await waitFor(() => expect(getState).toHaveBeenCalled());
    await act(async () => {});
    clickNotification({ circleKey: KEY, channel: 'garden', ref: { author: MAYA, id: '0123456789abcdef' } });
    await screen.findByText('Garden plans');
    expect(within(circlesRail()).getByRole('button', { name: 'Garden' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' }));
    const row = scrollIntoView.mock.contexts[0] as HTMLElement;
    expect(row.getAttribute('data-message')).toBe(`${MAYA}/0123456789abcdef`);
  });

  it('ignores a notification for a Circle this device does not have', async () => {
    const commands: unknown[] = [];
    const onCommand = (event: Event) => commands.push((event as CustomEvent).detail);
    window.addEventListener('boundary:command', onCommand);
    render(<Shell />);
    await within(rail()).findByRole('button', { name: /Mentions/ });
    await waitFor(() => expect(getState).toHaveBeenCalled());
    await act(async () => {});
    expect(() =>
      clickNotification({ circleKey: 'ff'.repeat(32), channel: 'general', ref: { author: MAYA, id: '0123456789abcdef' } })
    ).not.toThrow();
    window.removeEventListener('boundary:command', onCommand);
    expect(screen.queryByRole('complementary', { name: 'Circles' })).toBeNull();
    expect(within(rail()).getByRole('button', { name: /Mentions/ })).toBeTruthy();
    expect(window.localStorage.getItem('boundary:chat-place')).toBeNull();
    expect(commands).not.toContain('go-circles');
  });

  it('sends focus and blur to main while the channel is open, and stops after unmount', async () => {
    openCircle(KEY);
    const { unmount } = render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    viewing.mockClear();
    act(() => void window.dispatchEvent(new Event('blur')));
    expect(viewing).toHaveBeenLastCalledWith({ circleKey: KEY, channel: 'general', focused: document.hasFocus() });
    const focused = vi.spyOn(document, 'hasFocus');
    focused.mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event('blur')));
    expect(viewing).toHaveBeenLastCalledWith({ circleKey: KEY, channel: 'general', focused: false });
    focused.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(viewing).toHaveBeenLastCalledWith({ circleKey: KEY, channel: 'general', focused: true });
    unmount();
    expect(viewing).toHaveBeenLastCalledWith(null);
    viewing.mockClear();
    act(() => void window.dispatchEvent(new Event('blur')));
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(viewing).not.toHaveBeenCalled();
    focused.mockRestore();
  });

  it('leaves a live message unread while the window is unfocused, so main can still notify for it', async () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    openCircle(KEY);
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    const live = message('Seeds arrived', { id: 'aaaa000000000001', at: message('').at + 1000 });
    emit({ added: [live] });
    await screen.findByText('Seeds arrived');
    expect(chatRead).not.toHaveBeenCalled();
    focused.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() =>
      expect(chatRead).toHaveBeenCalledWith({ key: KEY, channel: 'general', position: { author: MAYA, id: live.id, at: live.at } }),
    );
    expect(chatRead).toHaveBeenCalledTimes(1);
    focused.mockRestore();
  });

  it('marks the open channel read again when someone reacts to an older message of mine that isn’t loaded', async () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    openCircle(KEY);
    render(<CirclesScreen />);
    await screen.findByText('Chapter 3 tonight?');
    await waitFor(() => expect(chatRead).toHaveBeenCalledTimes(1));
    // Main reports the reacted message as changed; it is older than the loaded page, so the
    // thread reads the same tail again and never loads it.
    const old = message('From last month', {
      author: ME,
      id: '00000000000000aa',
      name: 'Ada',
      mine: true,
      at: message('').at - 30 * 86_400_000,
      reactions: [{ emoji: '👍', count: 1, mine: false, people: [{ identity: MAYA, name: 'Maya', left: false, at: message('').at + 5_000 }] }],
    });
    emit({ changed: [old] });
    await waitFor(() => expect(chatRead).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('From last month')).toBeNull();
    // The same reaction reported again doesn't mark it read a third time, nor does refocusing.
    emit({ changed: [old] });
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(chatMessages.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(chatRead).toHaveBeenCalledTimes(2);
    focused.mockRestore();
  });

  it('still scrolls to the message when a live message arrives before its row has rendered', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const target = message('Garden plans', { channel: 'garden' });
    const live = message('Seeds arrived', { channel: 'garden', id: 'aaaa000000000001', at: target.at + 1000 });
    chatMessages.mockResolvedValue({ success: true, state: running, messages: [target], more: false });
    // The live message lands when the thread first looks for the target's row and doesn't find it,
    // queued as a microtask rather than a timer.
    const selector = `[data-message="${target.author}/${target.id}"]`;
    const querySelector = document.querySelector.bind(document);
    let sent = false;
    const lookup = vi.spyOn(document, 'querySelector').mockImplementation((query: string) => {
      const found = querySelector(query);
      if (query === selector && !found && !sent) {
        sent = true;
        queueMicrotask(() =>
          act(() => {
            for (const listener of chatListeners) listener({ circleKey: KEY, channel: 'garden', added: [live], changed: [], gone: [] });
          }),
        );
      }
      return found;
    });
    render(<Shell />);
    await within(rail()).findByRole('button', { name: /Mentions/ });
    await waitFor(() => expect(getState).toHaveBeenCalled());
    await act(async () => {});
    clickNotification({ circleKey: KEY, channel: 'garden', ref: { author: target.author, id: target.id } });
    await screen.findByText('Seeds arrived');
    expect(sent).toBe(true);
    lookup.mockRestore();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' }));
  });
});

describe('the dock grip', () => {
  const STORAGE_KEY = 'boundary:circles-dock-height';
  let railHeight = 700;
  let spacerHeight = 0;

  beforeEach(() => {
    window.localStorage.clear();
    railHeight = 700;
    spacerHeight = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains('wb-circle-rail')
        ? railHeight
        : this.classList.contains('wb-titlebar-spacer')
          ? spacerHeight
          : 0;
      return { top: 0, bottom: height, left: 0, right: 0, width: 0, height, x: 0, y: 0, toJSON: () => ({}) };
    });
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true, writable: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture');
  });

  const mountRail = () => render(<CirclesRail area={<p>Area</p>} dock={<p>Dock</p>} />);
  const grip = () => screen.getByRole('separator', { name: 'Resize Circle list' });
  const dock = () => document.querySelector<HTMLElement>('.wb-circles-dock') as HTMLElement;
  const resizeWindow = (height: number) => {
    railHeight = height;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
  };

  it('resizes the dock by dragging the grip and keeps the height after a remount', () => {
    const { unmount } = mountRail();
    expect(dock().style.height).toBe(`${DOCK_DEFAULT_PX}px`);
    fireEvent.pointerDown(grip(), { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(grip(), { clientY: 360, pointerId: 1 });
    expect(dock().style.height).toBe(`${DOCK_DEFAULT_PX + 40}px`);
    fireEvent.pointerUp(grip(), { clientY: 360, pointerId: 1 });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(DOCK_DEFAULT_PX + 40));
    unmount();
    mountRail();
    expect(dock().style.height).toBe(`${DOCK_DEFAULT_PX + 40}px`);
  });

  it('moves the grip a row at a time with the arrow keys', () => {
    mountRail();
    fireEvent.keyDown(grip(), { key: 'ArrowUp' });
    expect(dock().style.height).toBe(`${DOCK_DEFAULT_PX + ROW_PX}px`);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(DOCK_DEFAULT_PX + ROW_PX));
    fireEvent.keyDown(grip(), { key: 'ArrowDown' });
    fireEvent.keyDown(grip(), { key: 'ArrowDown' });
    expect(dock().style.height).toBe(`${DOCK_DEFAULT_PX - ROW_PX}px`);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(DOCK_DEFAULT_PX - ROW_PX));
    expect(grip().getAttribute('aria-valuenow')).toBe(String(DOCK_DEFAULT_PX - ROW_PX));
    expect(grip().getAttribute('aria-valuemin')).toBe(String(DOCK_MIN_PX));
  });

  it('saves nothing for an arrow key at the limit the window allows', () => {
    window.localStorage.setItem(STORAGE_KEY, '400');
    mountRail();
    resizeWindow(500);
    const limit = 500 - AREA_MIN_PX;
    expect(dock().style.height).toBe(`${limit}px`);
    fireEvent.keyDown(grip(), { key: 'ArrowUp' });
    expect(dock().style.height).toBe(`${limit}px`);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('400');
    resizeWindow(700);
    expect(dock().style.height).toBe('400px');
    fireEvent.keyDown(grip(), { key: 'ArrowDown' });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(400 - ROW_PX));
  });

  it('goes to the smallest and largest dock with Home and End, and keeps them', () => {
    mountRail();
    fireEvent.keyDown(grip(), { key: 'Home' });
    expect(dock().style.height).toBe(`${DOCK_MIN_PX}px`);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(DOCK_MIN_PX));
    fireEvent.keyDown(grip(), { key: 'End' });
    const max = grip().getAttribute('aria-valuemax');
    expect(dock().style.height).toBe(`${max}px`);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(max);
  });

  it('names its value in rows and the dock it controls', () => {
    mountRail();
    expect(grip().getAttribute('aria-valuetext')).toBe('6 rows');
    fireEvent.keyDown(grip(), { key: 'ArrowUp' });
    expect(grip().getAttribute('aria-valuetext')).toBe('7 rows');
    expect(dock().id).not.toBe('');
    expect(grip().getAttribute('aria-controls')).toBe(dock().id);
  });

  it('finishes a drag that ends outside the window', () => {
    const save = vi.spyOn(window.localStorage, 'setItem');
    mountRail();
    fireEvent.pointerDown(grip(), { clientY: 400, pointerId: 1 });
    expect(HTMLElement.prototype.setPointerCapture).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(grip(), { clientY: -900, pointerId: 1 });
    fireEvent.pointerUp(grip(), { clientY: -900, pointerId: 1 });
    expect(save.mock.calls.filter(([key]) => key === STORAGE_KEY)).toHaveLength(1);
    // The Circle area keeps its four rows, so the dock stops at the largest height allowed.
    expect(dock().style.height).toBe(`${Number(grip().getAttribute('aria-valuemax'))}px`);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(grip().getAttribute('aria-valuemax'));
  });

  it('holds both minimums in a short window without forgetting the stored height', () => {
    window.localStorage.setItem(STORAGE_KEY, '400');
    mountRail();
    resizeWindow(500);
    expect(dock().style.height).toBe(`${500 - AREA_MIN_PX}px`);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('400');
    resizeWindow(700);
    expect(dock().style.height).toBe('400px');
  });

  it('keeps the Circle area its minimum when a titlebar spacer takes part of the rail', () => {
    spacerHeight = 42;
    window.localStorage.setItem(STORAGE_KEY, '400');
    mountRail();
    // 440px under a 42px spacer leaves 398px to share; the area keeps AREA_MIN_PX of it.
    resizeWindow(440);
    expect(dock().style.height).toBe(`${440 - 42 - AREA_MIN_PX}px`);
  });

  it('paints the stored height on the first render, before the rail is measured', () => {
    window.localStorage.setItem(STORAGE_KEY, '400');
    const firstPaint: string[] = [];
    // A child's layout effect runs before the rail's own, so it sees the first committed height.
    const Probe: React.FC = () => {
      const ref = React.useRef<HTMLParagraphElement>(null);
      React.useLayoutEffect(() => {
        firstPaint.push((ref.current?.parentElement as HTMLElement).style.height);
      }, []);
      return <p ref={ref}>Dock</p>;
    };
    render(<CirclesRail area={<p>Area</p>} dock={<Probe />} />);
    expect(firstPaint).toEqual(['400px']);
  });

  it('does not save when the grip is clicked without moving, even in a short window', () => {
    window.localStorage.setItem(STORAGE_KEY, '400');
    mountRail();
    resizeWindow(500);
    expect(dock().style.height).toBe(`${500 - AREA_MIN_PX}px`);
    fireEvent.pointerDown(grip(), { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(grip(), { clientY: 400, pointerId: 1 });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('400');
  });

  it('has no grip when no Circle is open, and the dock fills the rail', () => {
    render(<CirclesRail area={null} dock={<p>Dock</p>} />);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(dock().style.height).toBe('');
  });
});
