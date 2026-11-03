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

stubElectronAPI({
  circles: {
    getState: (...args: unknown[]) => getState(...args),
    chatAddChannel: (...args: unknown[]) => chatAddChannel(...args),
    onChannelsChanged: (listener: (event: { circleKey: string }) => void) => {
      channelListeners.add(listener);
      return () => channelListeners.delete(listener);
    },
    onState: vi.fn(() => () => undefined),
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
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    chatListeners.clear();
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
    fireEvent.click(await screen.findByRole('button', { name: /^Place: This Mac/ }));
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
