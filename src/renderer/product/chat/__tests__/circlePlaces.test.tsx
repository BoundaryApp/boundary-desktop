import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CircleChatPresence,
  CircleChatUpdate,
  CircleMessage,
  CircleSnapshot,
  CirclesState,
} from '../../../../shared/types/circles';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { clearChatScreenSnapshot } from '../chatScreenCache';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const ME = 'aa'.repeat(32);
const MAYA = 'bb'.repeat(32);
const KEY = 'cc'.repeat(32);

const circle: CircleSnapshot = {
  key: KEY,
  name: 'Book club',
  myRole: 'member',
  members: [
    { identity: ME, name: 'Ada', role: 'member', isMe: true, online: true },
    { identity: MAYA, name: 'Maya', role: 'admin', isMe: false, online: true },
  ],
  invites: [],
  offers: [],
  needsUpdate: false,
  writable: true,
};

const running: CirclesState = {
  status: 'running',
  displayName: 'Ada',
  snapshot: { identity: ME, circles: [circle] },
  providers: {},
  sharing: { models: [], circles: [], paused: false, away: false },
};

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

vi.mock('../HermesChatRuntimeProvider', () => ({
  HermesChatRuntimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../WorkbenchThread', () => ({
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

import { WorkbenchChatScreen } from '../WorkbenchChatScreen';
import { resetChatPlaceForTests, showCirclePlace } from '../circlePlace';
import { dispatchAppCommand } from '../../useAppShortcuts';
import { resetCallCheckForTests } from '../../circles/useCallCheck';

function emit(update: Partial<CircleChatUpdate>) {
  act(() => {
    for (const listener of chatListeners) {
      listener({ circleKey: KEY, channel: 'general', added: [], changed: [], gone: [], ...update });
    }
  });
}

const rail = () => screen.getAllByRole('complementary')[0];

function pushState(next: CirclesState) {
  act(() => {
    for (const listener of stateListeners) listener(next);
  });
}

const empty: CirclesState = { ...running, snapshot: { identity: ME, circles: [] } };

describe('Circle places in the chat screen', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetChatPlaceForTests();
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
    getState.mockResolvedValue(running);
    leave.mockResolvedValue({ success: true, state: running });
    removeMember.mockResolvedValue({ success: true, state: running });
    setRole.mockResolvedValue({ success: true, state: running });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    chatListeners.clear();
    stateListeners.clear();
    presenceListeners.clear();
    channelListeners.clear();
    resetCallCheckForTests();
    vi.useRealTimers();
  });

  it('shows a member typing until 6 seconds after their last signal', async () => {
    showCirclePlace(KEY);
    render(<WorkbenchChatScreen />);
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

  it('keeps This Mac’s rail as it was, with the switcher above it', async () => {
    render(<WorkbenchChatScreen />);
    await screen.findByRole('button', { name: 'Place: This Mac, 3 unread elsewhere' });
    expect(within(rail()).getByRole('button', { name: /Mentions/ })).toBeTruthy();
    expect(within(rail()).getByRole('button', { name: 'All chats' })).toBeTruthy();
    expect(within(rail()).queryByText('Book club')).toBeNull();
  });

  it('shows only the Circle in its place: channels, people and the channel, with no Hermes controls', async () => {
    render(<WorkbenchChatScreen />);
    // The switcher shows before Circles load; wait for the Circle's unread count.
    fireEvent.click(await screen.findByRole('button', { name: 'Place: This Mac, 3 unread elsewhere' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Book club, 3 unread' }));

    expect(await screen.findByText('Chapter 3 tonight?')).toBeTruthy();
    const circleRail = screen.getByRole('complementary', { name: 'Book club chats' });
    expect(within(circleRail).getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page');
    expect(within(circleRail).getByRole('button', { name: 'Garden, 3 unread' })).toBeTruthy();
    expect(within(circleRail).getByRole('button', { name: /^You/ })).toBeTruthy();
    expect(within(circleRail).queryByRole('button', { name: /Mentions/ })).toBeNull();
    expect(within(circleRail).queryByRole('button', { name: 'All chats' })).toBeNull();
    expect(screen.queryByText(/hermes-thread/)).toBeNull();

    expect(screen.getByPlaceholderText('Message Book club · 2 people')).toBeTruthy();
    expect(screen.getByText('Everyone in Book club gets a copy')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Tools' })).toBeNull();
    expect(screen.queryByRole('button', { name: '@' })).toBeNull();
    // The panel starts closed, and the header's button opens it.
    expect(screen.queryByRole('complementary', { name: 'Circle details' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Circle details' }));
    expect(screen.getByRole('complementary', { name: 'Circle details' })).toBeTruthy();

    await waitFor(() => expect(chatRead).toHaveBeenCalledWith({
      key: KEY,
      channel: 'general',
      position: { author: MAYA, id: '0123456789abcdef', at: message('').at },
    }));
  });

  it('gives admins channel controls and members none', async () => {
    showCirclePlace(KEY);
    const { unmount } = render(<WorkbenchChatScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Open Circle details' }));
    expect(screen.getByRole('complementary', { name: 'Circle details' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a channel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename General' })).toBeNull();
    unmount();

    const admin = { ...circle, myRole: 'admin' as const };
    getState.mockResolvedValue({ ...running, snapshot: { identity: ME, circles: [admin] } });
    render(<WorkbenchChatScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Open Circle details' }));
    const tab = screen.getByRole('complementary', { name: 'Circle details' });
    expect(within(tab).getByRole('button', { name: 'Rename General' })).toBeTruthy();
    expect(within(tab).queryByRole('button', { name: 'Remove General' })).toBeNull();
    expect(within(tab).getByRole('button', { name: 'Remove Garden' })).toBeTruthy();
  });

  it('opens a person from a who-line, with what they share and a link to Inference', async () => {
    const offers = [{ identity: MAYA, name: 'Maya', isMine: false, online: true, available: true, away: false, models: [{ id: 'qwen3-32b' }] }];
    getState.mockResolvedValue({ ...running, snapshot: { identity: ME, circles: [{ ...circle, offers }] } });
    const opened = vi.fn();
    window.addEventListener('boundary:open-inference', opened);
    showCirclePlace(KEY);
    render(<WorkbenchChatScreen />);
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
    getState.mockResolvedValue({ ...running, snapshot: { identity: ME, circles: [admin] } });
    showCirclePlace(KEY);
    render(<WorkbenchChatScreen />);
    await screen.findByText('Chapter 3 tonight?');

    fireEvent.click(within(screen.getByRole('complementary', { name: 'Book club chats' })).getByRole('button', { name: /^Maya/ }));
    const panel = screen.getByRole('complementary', { name: 'Maya' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Make admin' }));
    await waitFor(() => expect(setRole).toHaveBeenCalledWith({ key: KEY, identity: MAYA, role: 'admin' }));

    fireEvent.click(within(panel).getByRole('button', { name: 'Remove from Book club' }));
    const sheet = screen.getByRole('dialog', { name: 'Remove Maya from Book club?' });
    expect(removeMember).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith({ key: KEY, identity: MAYA }));
  });

  it('shows an admin the open invites, and opens the invite sheet from the tab and the rail', async () => {
    const invites = [
      { id: 'inv1', expires: Date.now() + 3 * 24 * 60 * 60_000, revoked: false, used: false },
      { id: 'inv2', expires: Date.now() - 1, revoked: false, used: false },
    ];
    getState.mockResolvedValue({
      ...running,
      inviteLabels: { inv1: 'Priya' },
      inviteCodeIds: ['inv1'],
      snapshot: { identity: ME, circles: [{ ...circle, myRole: 'admin', invites }] },
    });
    showCirclePlace(KEY);
    render(<WorkbenchChatScreen />);
    await screen.findByText('Chapter 3 tonight?');

    // Inviting from the rail opens the panel behind the sheet.
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Book club chats' })).getByRole('button', { name: 'Invite someone' }));
    expect(screen.getByRole('dialog', { name: 'Invite to Book club' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    const tab = screen.getByRole('complementary', { name: 'Circle details' });
    const open = within(tab).getByRole('list', { name: 'Open invites' });
    await within(open).findByText('For Priya · yrb7…');
    expect(within(open).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(within(open).getByRole('button'));
    expect(screen.getByRole('dialog', { name: 'Invite to Book club' })).toBeTruthy();
  });

  it('leaves the Circle from the tab’s foot after asking, and offers Delete to its last member', async () => {
    showCirclePlace(KEY);
    const { unmount } = render(<WorkbenchChatScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Open Circle details' }));
    // Members get no invite controls.
    expect(screen.queryByRole('button', { name: 'Invite someone' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Leave Book club' }));
    const sheet = screen.getByRole('dialog', { name: 'Leave Book club?' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith({ key: KEY }));
    unmount();

    getState.mockResolvedValue({ ...running, snapshot: { identity: ME, circles: [{ ...circle, myRole: 'admin', members: [circle.members[0]] }] } });
    render(<WorkbenchChatScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Open Circle details' }));
    expect(screen.queryByRole('button', { name: 'Leave Book club' })).toBeNull();
    deleteCircle.mockResolvedValue({ success: true, state: running });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Book club' }));
    const deleting = screen.getByRole('dialog', { name: 'Delete Book club?' });
    expect(within(deleting).getByText(/you can’t get it back/)).toBeTruthy();
    fireEvent.click(within(deleting).getByRole('button', { name: 'Delete Circle' }));
    await waitFor(() => expect(deleteCircle).toHaveBeenCalledWith({ key: KEY }));
  });

  it('says a leave finishes once an admin is online, and lists it in the switcher until then', async () => {
    const left: CirclesState = { ...running, snapshot: { identity: ME, circles: [], leaving: [{ key: KEY, name: 'Book club' }] } };
    leave.mockResolvedValue({ success: true, state: left });
    showCirclePlace(KEY);
    render(<WorkbenchChatScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Open Circle details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave Book club' }));
    const sheet = screen.getByRole('dialog', { name: 'Leave Book club?' });
    expect(within(sheet).getByText(/If no admin is online, the leave finishes the next time one is/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith({ key: KEY }));
    pushState(left);
    fireEvent.click(await screen.findByRole('button', { name: /^Place: This Mac/ }));
    const menu = screen.getByRole('menu', { name: 'Places' });
    expect(menu.textContent).toMatch(/Leaving Book clubFinishes when an admin is online/);
    pushState({ ...left, snapshot: { ...left.snapshot!, leaving: undefined } });
    expect(screen.getByRole('menu', { name: 'Places' }).textContent).not.toMatch(/Leaving/);
  });

  it('explains Circles in the switcher when there are none, and starts one there', async () => {
    getState.mockResolvedValue(empty);
    create.mockResolvedValue({ success: true, state: empty, key: KEY });
    render(<WorkbenchChatScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Place: This Mac' }));
    expect(screen.getByText(/A Circle is a small invite-only group/)).toBeTruthy();
    expect(screen.queryByText('Circles', { selector: '.wb-place-menu-head' })).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Start a Circle…' }));
    const sheet = screen.getByRole('dialog', { name: 'Start a Circle' });
    // The user has a name, so the sheet doesn't ask for one.
    expect(within(sheet).queryByLabelText(/Your name in Circles/)).toBeNull();
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Book club' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'Book club' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start a Circle' })).toBeNull());
    // The new Circle reaches the state after create returns; the chat switches once it does.
    expect(screen.queryByRole('complementary', { name: 'Book club chats' })).toBeNull();
    pushState(running);
    expect(await screen.findByRole('complementary', { name: 'Book club chats' })).toBeTruthy();
  });

  it('asks for the user’s name first when they have none', async () => {
    getState.mockResolvedValue({ ...empty, status: 'stopped', displayName: '' });
    setDisplayName.mockResolvedValue({ success: true, state: empty });
    create.mockResolvedValue({ success: true, state: empty, key: KEY });
    render(<WorkbenchChatScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Place: This Mac' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start a Circle…' }));
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
    render(<WorkbenchChatScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Place: This Mac' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Join with an invite…' }));
    const sheet = screen.getByRole('dialog', { name: 'Join with an invite' });
    fireEvent.change(within(sheet).getByLabelText('Invite code'), { target: { value: ' yrb7ei1ng ' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Join' }));
    expect(join).toHaveBeenCalledWith({ code: 'yrb7ei1ng' });

    // Main marks the join as waiting when it starts, and the page shows.
    pushState({ ...empty, join: { waiting: true } });
    expect(screen.getByText('Waiting for an admin to let you in')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Place: Joining a Circle…' })).toBeTruthy();

    // Going elsewhere keeps the join in the menu.
    fireEvent.click(screen.getByRole('button', { name: 'Place: Joining a Circle…' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^This Mac/ }));
    expect(screen.queryByText('Waiting for an admin to let you in')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Place: This Mac' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Joining a Circle… Waiting for an admin' }));
    expect(screen.getByText('Waiting for an admin to let you in')).toBeTruthy();

    // Let in: the Circle replaces the row and the page moves into it.
    pushState({ ...running, join: null, finishingJoin: KEY });
    expect(await screen.findByRole('complementary', { name: 'Book club chats' })).toBeTruthy();
  });

  it('shows a failed join on its page and goes back to This Mac when closed', async () => {
    getState.mockResolvedValue({ ...empty, join: { waiting: false, error: 'That invite has been used.' } });
    cancelJoin.mockResolvedValue({ success: true, state: empty });
    render(<WorkbenchChatScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Place: This Mac' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Joining a Circle… Couldn’t join' }));
    expect(screen.getByText('The invite didn’t work')).toBeTruthy();
    expect(screen.getByText('That invite has been used.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(cancelJoin).toHaveBeenCalled());
    pushState(empty);
    expect(await screen.findByRole('button', { name: 'Place: This Mac' })).toBeTruthy();
    expect(screen.queryByText('The invite didn’t work')).toBeNull();
  });

  it('says in the menu when Circles can’t connect', async () => {
    getState.mockResolvedValue({ ...empty, status: 'failed', error: 'The network process stopped.' });
    render(<WorkbenchChatScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Place: This Mac' }));
    expect(screen.getByText(/Circles can’t connect: The network process stopped\./)).toBeTruthy();
    const opened = vi.fn();
    window.addEventListener('boundary:open-settings', opened);
    fireEvent.click(screen.getByRole('button', { name: 'Circles profile' }));
    window.removeEventListener('boundary:open-settings', opened);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'general' });
  });

  it('adds a channel from the rail and opens it', async () => {
    getState.mockResolvedValue({ ...running, snapshot: { identity: ME, circles: [{ ...circle, myRole: 'admin' }] } });
    chatAddChannel.mockResolvedValue({ success: true, state: running, id: 'picks-a1b2c3' });
    showCirclePlace(KEY);
    render(<WorkbenchChatScreen />);
    await screen.findByText('Chapter 3 tonight?');
    const circleRail = screen.getByRole('complementary', { name: 'Book club chats' });
    fireEvent.click(within(circleRail).getByRole('button', { name: 'Add a channel' }));
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
      expect(within(circleRail).getByRole('button', { name: 'Picks' }).getAttribute('aria-current')).toBe('page')
    );
  });

  it('reopens the Circle on the channel last open there', async () => {
    showCirclePlace(KEY, 'garden');
    render(<WorkbenchChatScreen />);
    const circleRail = await screen.findByRole('complementary', { name: 'Book club chats' });
    await waitFor(() =>
      expect(within(circleRail).getByRole('button', { name: 'Garden' }).getAttribute('aria-current')).toBe('page')
    );
    expect(chatMessages).toHaveBeenLastCalledWith({ key: KEY, channel: 'garden', limit: 50 });
  });

  it('adds a message from a chat event, and sends what the user types', async () => {
    showCirclePlace(KEY);
    render(<WorkbenchChatScreen />);
    await screen.findByText('Chapter 3 tonight?');
    emit({ added: [message('Yes, 7pm', { id: '1111111111111111', confirmed: false })] });
    expect(screen.getByText('Yes, 7pm')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Waiting for admins to confirm/ })).toBeTruthy();

    const box = screen.getByRole('textbox', { name: 'Message Book club' });
    fireEvent.change(box, { target: { value: 'See you there' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(chatPost).toHaveBeenCalledWith({ key: KEY, channel: 'general', text: 'See you there' }));
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  describe('sharing from a Hermes chat', () => {
    it('posts exactly the text in the box, marked as shared, and opens the channel from the toast', async () => {
      render(<WorkbenchChatScreen />);
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
      expect(screen.getByRole('button', { name: /^Place: This Mac/ })).toBeTruthy();
      fireEvent.click(within(toast).getByRole('button', { name: 'Open' }));
      const circleRail = await screen.findByRole('complementary', { name: 'Book club chats' });
      expect(within(circleRail).getByRole('button', { name: 'Garden' }).getAttribute('aria-current')).toBe('page');
    });

    it('sends nothing on cancel', async () => {
      render(<WorkbenchChatScreen />);
      fireEvent.click(await screen.findByRole('button', { name: 'Share to Circle…' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('textbox', { name: 'Text to share' })).toBeNull();
      expect(chatPost).not.toHaveBeenCalled();
    });

    it('isn’t offered to someone in no Circle', async () => {
      getState.mockResolvedValue({ ...running, snapshot: { identity: ME, circles: [] } });
      render(<WorkbenchChatScreen />);
      await screen.findByText(/hermes-thread/);
      expect(screen.queryByRole('button', { name: 'Share to Circle…' })).toBeNull();
    });
  });

  it('stays in the Circle when the chat list loads and lands on the last Hermes chat', async () => {
    // Found in the harness: landing on the newest chat at launch counted as opening it.
    const listThreads = vi.mocked(window.electronAPI.hermesChat.listThreads);
    listThreads.mockResolvedValueOnce({
      success: true,
      threads: [{ id: 'hermes-1', title: 'Map in chapter 2', kind: 'hermes', updatedAt: '2026-11-03T08:31:00Z' }],
    });
    showCirclePlace(KEY);
    render(<WorkbenchChatScreen />);
    await screen.findByRole('complementary', { name: 'Book club chats' });
    await waitFor(() => expect(listThreads).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByRole('complementary', { name: 'Book club chats' })).toBeTruthy();
    expect(screen.queryByText(/hermes-thread/)).toBeNull();
  });

  it('offers the call check only while it is on', async () => {
    vi.mocked(window.electronAPI.circles.callCheckEnabled).mockResolvedValueOnce(false);
    showCirclePlace(KEY);
    render(<WorkbenchChatScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Open Circle details' }));
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Call check…' })).toBeNull();
  });

  it('runs the call check against a member and logs metadata for each mode', async () => {
    const circles = vi.mocked(window.electronAPI.circles);
    circles.callCheckEnabled.mockResolvedValueOnce(true);
    circles.callSignalSend.mockResolvedValue(true);
    circles.callCheckResult.mockImplementation(async (result) => result);
    showCirclePlace(KEY);
    render(<WorkbenchChatScreen />);
    await screen.findByText('Chapter 3 tonight?');
    fireEvent.click(screen.getByRole('button', { name: 'Open Circle details' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Call check…' }));
    expect(screen.getByRole('combobox', { name: 'Member' })).toHaveProperty('value', MAYA);
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    // jsdom has no WebRTC, so every connection fails before an offer goes out.
    const table = await screen.findByRole('table', { name: 'Call check results' });
    await waitFor(() => expect(within(table).getAllByText('Failed at error')).toHaveLength(3));
    expect(circles.callCheckResult.mock.calls.map(([result]) => [result.mode, result.role, result.failedAt])).toEqual([
      ['host', 'caller', 'error'],
      ['stun', 'caller', 'error'],
      ['swarm', 'caller', 'error'],
    ]);
    for (const [result] of circles.callCheckResult.mock.calls) {
      expect(Object.keys(result).sort()).toEqual(['connected', 'failedAt', 'kind', 'mode', 'role', 'run']);
    }
    circles.callSignalSend.mockReset();
    circles.callCheckResult.mockReset();
  });

  it('switches to This Mac when a Hermes chat is started from a Circle', async () => {
    showCirclePlace(KEY);
    render(<WorkbenchChatScreen />);
    await screen.findByRole('complementary', { name: 'Book club chats' });
    act(() => dispatchAppCommand('new-chat'));
    await screen.findByRole('button', { name: /^Place: This Mac/ });
    expect(screen.queryByRole('complementary', { name: 'Book club chats' })).toBeNull();
  });
});
