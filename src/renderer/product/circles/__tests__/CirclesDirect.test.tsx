import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectConversation, DirectEvent, DirectMessage } from '../../../../shared/types/circles';
import { CIRCLE_KEY as KEY, ME, circleMember, circleSnapshot, runningCircles } from '../../../__tests__/circleFixtures';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { resetRememberedForTests } from '../../chat/circle/threadParts';

const MAYA = 'bb'.repeat(32);
const SAM = 'dd'.repeat(32);

const circle = circleSnapshot({
  name: 'Book club',
  members: [
    circleMember({ identity: ME, name: 'Ada', isMe: true }),
    circleMember({ identity: MAYA, name: 'Maya' }),
    circleMember({ identity: SAM, name: 'Sam', online: false }),
  ],
});
const running = runningCircles({ circles: [circle] });

const dm = (text: string, extra: Partial<DirectMessage> = {}): DirectMessage => ({
  id: '0123456789abcdef',
  author: MAYA,
  mine: false,
  text,
  at: Date.UTC(2026, 10, 12, 9, 12),
  reply: null,
  edited: false,
  deleted: false,
  delivery: null,
  neverSent: false,
  ...extra,
});

const dmListeners = new Set<(event: DirectEvent) => void>();
const dmList = vi.fn();
const dmMessages = vi.fn();
const dmSend = vi.fn();
const dmDelete = vi.fn();
const dmRead = vi.fn();
const chatChannels = vi.fn();
const getState = vi.fn();
const viewing = vi.fn();
const openListeners = new Set<(target: { circleKey: string; channel: string; ref: { author: string; id: string } }) => void>();

stubElectronAPI({
  circles: {
    chatChannels: (...args: unknown[]) => chatChannels(...args),
    getState: (...args: unknown[]) => getState(...args),
    chatMessages: vi.fn(async () => ({ success: true, state: running, messages: [], more: false })),
    chatRead: vi.fn(async () => ({ success: true, state: running })),
    notifyPrefs: vi.fn(() => new Promise(() => undefined)),
    dmList: (...args: unknown[]) => dmList(...args),
    dmMessages: (...args: unknown[]) => dmMessages(...args),
    dmSend: (...args: unknown[]) => dmSend(...args),
    dmDelete: (...args: unknown[]) => dmDelete(...args),
    dmRead: (...args: unknown[]) => dmRead(...args),
    dmTyping: vi.fn(async () => undefined),
    viewing: (...args: unknown[]) => viewing(...args),
    onOpenMessage: (listener: (target: { circleKey: string; channel: string; ref: { author: string; id: string } }) => void) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    onDmEvent: (listener: (event: DirectEvent) => void) => {
      dmListeners.add(listener);
      return () => dmListeners.delete(listener);
    },
  },
});

vi.mock('../../chat/HermesChatRuntimeProvider', () => ({
  HermesChatRuntimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { CirclesScreen } from '../CirclesScreen';
import { openCircle, openDirect, resetCirclesOpenForTests } from '../circlesNavigation';
import { placeDirect } from '../useDirectChat';
import { quoteLine } from '../../chat/circle/DirectThread';
import { useCircleNotificationClicks } from '../useCircleViewing';

const WithClicks: React.FC = () => {
  useCircleNotificationClicks();
  return <CirclesScreen />;
};

const conversation = (overrides: Partial<DirectConversation> = {}): DirectConversation => ({
  peer: MAYA,
  name: 'Maya',
  online: true,
  ended: false,
  last: { at: 1, text: 'Hi', mine: false, deleted: false },
  waiting: 0,
  unread: 0,
  ...overrides,
});

function emit(event: DirectEvent) {
  act(() => {
    for (const listener of dmListeners) listener(event);
  });
}

const main = () => screen.getByRole('main');
/** The screen's main is replaced once Circles' state arrives, so each try looks it up again. */
const findInMain = (text: string) => waitFor(() => within(main()).getByText(text));
const findBoxInMain = (name: string) => waitFor(() => within(main()).getByRole('textbox', { name }));

describe('direct messages on the Circles destination', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetCirclesOpenForTests();
    resetRememberedForTests();
    dmList.mockResolvedValue({ success: true, state: running, conversations: [conversation()] });
    dmMessages.mockResolvedValue({ success: true, state: running, messages: [dm('Snacks Thursday?')], more: false });
    dmSend.mockResolvedValue({ success: true, state: running, id: 'fedcba9876543210' });
    dmDelete.mockResolvedValue({ success: true, state: running, unsent: true });
    dmRead.mockResolvedValue({ success: true, state: running });
    getState.mockResolvedValue(running);
    chatChannels.mockResolvedValue({ success: true, state: running, channels: [{ id: 'general', name: 'General', unread: 0, mentioned: false }] });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    dmListeners.clear();
    openListeners.clear();
  });

  it('lists conversations under the open Circle and opens one with its own header, composer and hint', async () => {
    openCircle(KEY);
    render(<CirclesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Maya, direct message, online' }));
    expect(await findInMain('Snacks Thursday?')).toBeTruthy();
    expect(within(main()).getByText('· Direct message in Book club')).toBeTruthy();
    expect(within(main()).getByRole('textbox', { name: 'Message Maya' }).getAttribute('placeholder')).toBe('Message Maya · only Maya sees this');
    expect(within(main()).getByText('Only Maya')).toBeTruthy();
    expect(within(main()).getByText('Delivered when you’re both online. Nobody else in Book club sees it.')).toBeTruthy();
    // None of a channel's extras: no Circle audience, reactions or mentions.
    expect(main().querySelector('.wb-circle-audience')).toBeNull();
    expect(within(main()).queryByRole('button', { name: /react/i })).toBeNull();
    expect(within(main()).queryByText(/Everyone in Book club/)).toBeNull();
  });

  it('asks before opening a link in a direct message', async () => {
    dmMessages.mockResolvedValue({ success: true, state: running, messages: [dm('Menu: https://example.com/menu')], more: false });
    openCircle(KEY);
    render(<CirclesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Maya, direct message, online' }));
    fireEvent.click(await waitFor(() => within(main()).getByRole('button', { name: 'https://example.com/menu' })));
    const dialog = screen.getByRole('dialog', { name: 'Open this link in your browser?' });
    expect(within(dialog).getByRole('button', { name: 'Copy URL' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Open in browser' })).toBeTruthy();
  });

  it('shows none of the DM controls in a channel', async () => {
    openCircle(KEY, 'general');
    render(<CirclesScreen />);
    await findInMain('Everyone in Book club gets a copy');
    expect(within(main()).queryByText(/Only /)).toBeNull();
    expect(within(main()).queryByText(/Delivered when/)).toBeNull();
    expect(main().querySelector('.wb-direct-lock')).toBeNull();
  });

  it('starts a conversation from a person in the Circle tab', async () => {
    dmList.mockResolvedValue({ success: true, state: running, conversations: [] });
    dmMessages.mockResolvedValue({ success: true, state: running, messages: [], more: false });
    openCircle(KEY);
    render(<CirclesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Circle details' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Message Sam' }));
    expect(await findInMain('This is the start of your conversation with Sam')).toBeTruthy();
    expect(within(main()).getByText('Away')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sam, direct message, away' }).getAttribute('aria-current')).toBe('page');
  });

  it('sends what the user types, and puts a reply’s reference on it', async () => {
    openDirect(KEY, MAYA);
    render(<CirclesScreen />);
    await findInMain('Snacks Thursday?');
    fireEvent.click(within(main()).getByRole('button', { name: 'Reply' }));
    expect(within(main()).getByText('Replying to')).toBeTruthy();
    const box = within(main()).getByRole('textbox', { name: 'Message Maya' });
    fireEvent.change(box, { target: { value: 'I will bring them' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(dmSend).toHaveBeenCalledWith({ key: KEY, peer: MAYA, text: 'I will bring them', reply: { author: MAYA, id: '0123456789abcdef' } })
    );
    await waitFor(() => expect(within(main()).queryByText('Replying to')).toBeNull());
  });

  it('cancels a reply with Escape', async () => {
    openDirect(KEY, MAYA);
    render(<CirclesScreen />);
    await findInMain('Snacks Thursday?');
    fireEvent.click(within(main()).getByRole('button', { name: 'Reply' }));
    fireEvent.keyDown(within(main()).getByRole('textbox', { name: 'Message Maya' }), { key: 'Escape' });
    expect(within(main()).queryByText('Replying to')).toBeNull();
  });

  it('counts down near the limit and won’t send past it', async () => {
    openDirect(KEY, MAYA);
    render(<CirclesScreen />);
    const box = await findBoxInMain('Message Maya');
    fireEvent.change(box, { target: { value: 'x'.repeat(2_800) } });
    expect(within(main()).getByText('272 bytes left')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'x'.repeat(3_100) } });
    expect(within(main()).getByText('28 bytes over')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(dmSend).not.toHaveBeenCalled();
  });

  it('counts escaped bytes in the composer and the edit box', async () => {
    // 3,072 bytes of UTF-8, but each newline takes two once escaped: 4,096.
    const escaped = 'ab\n'.repeat(1024);
    dmMessages.mockResolvedValue({ success: true, state: running, messages: [dm('Mine', { author: ME, mine: true, delivery: 'delivered' })], more: false });
    openDirect(KEY, MAYA);
    render(<CirclesScreen />);
    const box = await findBoxInMain('Message Maya');
    fireEvent.change(box, { target: { value: escaped } });
    expect(within(main()).getByText('1,024 bytes over')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(dmSend).not.toHaveBeenCalled();
    fireEvent.click(within(main()).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(main()).getByRole('textbox', { name: 'Edit message' }), { target: { value: escaped } });
    expect(within(main()).getByText('That’s longer than a direct message can be.')).toBeTruthy();
  });

  it('says a message waits for someone offline, and deletes one that never left as never sent', async () => {
    dmList.mockResolvedValue({ success: true, state: running, conversations: [conversation({ peer: SAM, name: 'Sam', online: false, waiting: 1 })] });
    dmMessages.mockResolvedValue({
      success: true,
      state: running,
      messages: [dm('Pages 180 to 262.', { author: ME, mine: true, delivery: 'waiting', neverSent: true })],
      more: false,
    });
    openDirect(KEY, SAM);
    render(<CirclesScreen />);
    expect(await findInMain('Waiting for Sam to come online')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sam, direct message, 1 waiting' })).toBeTruthy();
    fireEvent.click(within(main()).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Delete before it’s sent?')).toBeTruthy();
    expect(screen.getByText('It hasn’t left this Mac, so it is removed and never sent.')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(dmDelete).toHaveBeenCalledWith({ key: KEY, peer: SAM, id: '0123456789abcdef' }));
    emit({ kind: 'unsent', circleKey: KEY, peer: SAM, id: '0123456789abcdef' });
    expect(await findInMain('Removed before Sam received it.')).toBeTruthy();
    expect(within(main()).queryByText('Pages 180 to 262.')).toBeNull();
  });

  it('warns that deleting a delivered message only reaches the other Mac later', async () => {
    dmMessages.mockResolvedValue({
      success: true,
      state: running,
      messages: [dm('See you', { author: ME, mine: true, delivery: 'delivered' })],
      more: false,
    });
    openDirect(KEY, MAYA);
    render(<CirclesScreen />);
    expect(await findInMain('Delivered')).toBeTruthy();
    fireEvent.click(within(main()).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('It disappears from Maya’s Mac the next time you’re both online. Anything Maya copied stays with Maya.')).toBeTruthy();
  });

  it('adds a message that arrives, and shows the other person typing until it does', async () => {
    openDirect(KEY, MAYA);
    render(<CirclesScreen />);
    await findInMain('Snacks Thursday?');
    emit({ kind: 'typing', circleKey: KEY, peer: MAYA });
    expect(within(main()).getByText('Maya is typing…')).toBeTruthy();
    emit({ kind: 'message', circleKey: KEY, peer: MAYA, message: dm('Running late', { id: '1111111111111111' }) });
    expect(await findInMain('Running late')).toBeTruthy();
    expect(within(main()).queryByText('Maya is typing…')).toBeNull();
  });

  it('keeps a channel’s draft and a DM’s draft and reply while moving between them', async () => {
    openCircle(KEY, 'general');
    render(<CirclesScreen />);
    fireEvent.change(await findBoxInMain('Message Book club'), { target: { value: 'Half a thought' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Maya, direct message, online' }));
    await findInMain('Snacks Thursday?');
    fireEvent.click(within(main()).getByRole('button', { name: 'Reply' }));
    fireEvent.change(within(main()).getByRole('textbox', { name: 'Message Maya' }), { target: { value: 'For Maya' } });
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(((await findBoxInMain('Message Book club')) as HTMLTextAreaElement).value).toBe('Half a thought');
    fireEvent.click(screen.getByRole('button', { name: 'Maya, direct message, online' }));
    expect(((await findBoxInMain('Message Maya')) as HTMLTextAreaElement).value).toBe('For Maya');
    expect(within(main()).getByText('Replying to')).toBeTruthy();
  });

  it('still counts unread messages in General while a DM is open', async () => {
    chatChannels.mockResolvedValue({
      success: true,
      state: running,
      channels: [{ id: 'general', name: 'General', unread: 4, mentioned: false }],
    });
    openDirect(KEY, MAYA);
    render(<CirclesScreen />);
    await findInMain('Snacks Thursday?');
    expect(await screen.findByRole('button', { name: 'General, 4 unread' })).toBeTruthy();
  });

  it('tells main the open conversation is on screen, so it stays silent for it', async () => {
    openDirect(KEY, MAYA);
    render(<CirclesScreen />);
    await findInMain('Snacks Thursday?');
    await waitFor(() => expect(viewing).toHaveBeenCalledWith({ circleKey: KEY, channel: `dm:${MAYA}`, focused: expect.any(Boolean) }));
  });

  it('opens the conversation a clicked notification names and lights up its message', async () => {
    openCircle(KEY, 'general');
    render(<WithClicks />);
    await findInMain('Everyone in Book club gets a copy');
    act(() => {
      for (const listener of openListeners) listener({ circleKey: KEY, channel: `dm:${MAYA}`, ref: { author: MAYA, id: '0123456789abcdef' } });
    });
    await findInMain('Snacks Thursday?');
    await waitFor(() => expect(main().querySelector(`[data-message="${MAYA}/0123456789abcdef"]`)?.className).toContain('is-highlighted'));
  });

  it('counts unread DMs on the row and in the Circle’s count, and marks the open one read', async () => {
    dmList.mockResolvedValue({
      success: true,
      state: running,
      conversations: [conversation({ unread: 2 }), conversation({ peer: SAM, name: 'Sam', online: false, unread: 1 })],
    });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    openDirect(KEY, MAYA);
    render(<CirclesScreen />);
    await findInMain('Snacks Thursday?');
    // The open conversation is being read, so only Sam's row counts.
    expect(await screen.findByRole('button', { name: 'Sam, direct message, away, 1 unread' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Maya, direct message, online' })).toBeTruthy();
    await waitFor(() => expect(dmRead).toHaveBeenCalledWith({ key: KEY, peer: MAYA, id: '0123456789abcdef' }));
  });

  it('adds unread DMs to a Circle’s count in the list when another Circle is open', async () => {
    const OTHER = 'ee'.repeat(32);
    const other = circleSnapshot({ key: OTHER, name: 'Attic', members: circle.members });
    const state = runningCircles({ circles: [circle, other] });
    getState.mockResolvedValue(state);
    dmList.mockImplementation(async ({ key }: { key: string }) => ({
      success: true,
      state,
      conversations: key === KEY ? [conversation({ unread: 2 })] : [],
    }));
    openCircle(OTHER, 'general');
    render(<CirclesScreen />);
    expect(await screen.findAllByRole('button', { name: 'Book club, 2 unread' })).not.toHaveLength(0);
  });

  it('shows a message whose time is past the Date range without throwing', async () => {
    dmMessages.mockResolvedValue({
      success: true,
      state: running,
      messages: [dm('Odd clock', { at: 8_640_000_000_000_001 })],
      more: false,
    });
    openDirect(KEY, MAYA);
    render(<CirclesScreen />);
    expect(await findInMain('Odd clock')).toBeTruthy();
  });

  it('makes a conversation with someone who left read-only', async () => {
    const left = circleSnapshot({ name: 'Book club', members: circle.members.filter((m) => m.identity !== MAYA) });
    const state = runningCircles({ circles: [left] });
    getState.mockResolvedValue(state);
    dmList.mockResolvedValue({ success: true, state, conversations: [conversation({ ended: true, online: false })] });
    openDirect(KEY, MAYA);
    render(<CirclesScreen />);
    expect(await findInMain('Maya left Book club. This conversation stays on this Mac, read-only, until you leave too.')).toBeTruthy();
    expect(within(main()).queryByRole('textbox', { name: 'Message Maya' })).toBeNull();
    expect(within(main()).queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Maya, direct message, left' })).toBeTruthy();
  });
});

describe('direct message helpers', () => {
  it('quotes the first line with Markdown marks removed, cut to 120 characters', () => {
    expect(quoteLine('\n**Bold** _start_\nsecond line')).toBe('Bold start');
    expect(quoteLine('x'.repeat(200))).toHaveLength(120);
  });

  it('puts a changed message in place and a new one last', () => {
    const first = dm('one');
    const second = dm('two', { id: '1111111111111111' });
    expect(placeDirect([first, second], { ...first, text: 'uno' }).map((m) => m.text)).toEqual(['uno', 'two']);
    expect(placeDirect([first], second).map((m) => m.text)).toEqual(['one', 'two']);
  });
});
