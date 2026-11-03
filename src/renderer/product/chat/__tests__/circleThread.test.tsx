import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CircleMessage, CircleSnapshot } from '../../../../shared/types/circles';
import { CircleThread } from '../circle/CircleThread';
import { applyChatUpdate, mergeTail, type CircleChatView } from '../../circles/useCircleChat';

const noop = () => undefined;
globalThis.ResizeObserver ??= class {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
} as unknown as typeof ResizeObserver;
Element.prototype.scrollTo ??= noop;

const ME = 'aa'.repeat(32);
const MAYA = 'bb'.repeat(32);
const SAM = 'dd'.repeat(32);
const AT = Date.UTC(2026, 10, 3, 9, 12);

const circle = (extra: Partial<CircleSnapshot> = {}): CircleSnapshot => ({
  key: 'cc'.repeat(32),
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
  ...extra,
});

let seq = 0;
const message = (text: string, extra: Partial<CircleMessage> = {}): CircleMessage => ({
  circleKey: 'cc'.repeat(32),
  channel: 'general',
  author: MAYA,
  id: (++seq).toString(16).padStart(16, '0'),
  name: 'Maya',
  agent: null,
  text,
  at: AT + seq * 60 * 60_000,
  confirmed: true,
  edited: false,
  deleted: null,
  shared: null,
  call: null,
  mine: false,
  ...extra,
});

function chatOf(messages: CircleMessage[], extra: Partial<CircleChatView> = {}): CircleChatView {
  return {
    messages,
    loading: false,
    more: false,
    error: null,
    goneCount: 0,
    loadOlder: vi.fn(async () => undefined),
    send: vi.fn(async () => null),
    edit: vi.fn(async () => null),
    remove: vi.fn(async () => null),
    markRead: vi.fn(),
    typing: [],
    seenBy: {},
    notifyTyping: vi.fn(),
    ...extra,
  };
}

const show = (snapshot: CircleSnapshot, chat: CircleChatView) =>
  render(<CircleThread circle={snapshot} channel={{ id: 'general', name: 'General' }} chat={chat} />);

const row = (text: string) => screen.getByText(text).closest('.wb-circle-msg') as HTMLElement;

describe('CircleThread', () => {
  afterEach(cleanup);

  it('names the Circle and channel, and marks people who left and deleted messages', () => {
    show(
      circle(),
      chatOf([
        message('Chapter 3?'),
        message('I’m out', { author: SAM, name: 'Sam' }),
        message('', { deleted: 'admin' }),
        message('', { author: ME, name: 'Ada', mine: true, deleted: 'author' }),
      ])
    );
    expect(screen.getByText('Circle channel · 2 people · 2 online')).toBeTruthy();
    expect(within(row('I’m out')).getByText('Left')).toBeTruthy();
    expect(within(row('Chapter 3?')).queryByText('Left')).toBeNull();
    expect(screen.getByText('Removed by an admin')).toBeTruthy();
    expect(screen.getByText('Deleted')).toBeTruthy();
  });

  it('offers Edit only on the user’s own message and Delete on others’ only to admins', () => {
    const { unmount } = show(circle(), chatOf([message('Hers'), message('Mine', { author: ME, name: 'Ada', mine: true })]));
    expect(within(row('Hers')).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(row('Mine')).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(row('Mine')).getByRole('button', { name: 'Delete' })).toBeTruthy();
    unmount();
    show(circle({ myRole: 'admin' }), chatOf([message('Hers')]));
    expect(within(row('Hers')).getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(within(row('Hers')).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('edits in place and deletes after the dialog', async () => {
    const mine = message('Draft', { author: ME, name: 'Ada', mine: true });
    const chat = chatOf([mine]);
    show(circle(), chat);
    fireEvent.click(within(row('Draft')).getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    fireEvent.change(box, { target: { value: 'Final' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(chat.edit).toHaveBeenCalledWith(mine.id, 'Final'));

    fireEvent.click(within(row('Draft')).getByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/Every member’s Mac still holds the Circle’s history, so it isn’t erased/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(chat.remove).toHaveBeenCalledWith({ author: ME, id: mine.id }));
  });

  it('says so when messages are unconfirmed and no admin is online', () => {
    const offline = circle({
      members: [
        { identity: ME, name: 'Ada', role: 'member', isMe: true, online: true },
        { identity: MAYA, name: 'Maya', role: 'admin', isMe: false, online: false },
      ],
    });
    show(offline, chatOf([message('Hello?', { confirmed: false })]));
    expect(screen.getByRole('img', { name: /Waiting for admins to confirm/ })).toBeTruthy();
    expect(screen.getByText('No admin is online. New messages show now and settle in order once one is.')).toBeTruthy();
  });

  it('shows no images, and marks a call and shared text', () => {
    const { container } = show(
      circle(),
      chatOf([
        message('![tracker](https://example.com/pixel.png) hi'),
        message('', { call: { id: 'ab'.repeat(8) } }),
        message('Summary', { shared: { role: 'assistant', model: 'qwen3-8b' } }),
      ])
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Started a call')).toBeTruthy();
    expect(screen.getByText('Shared from a chat · reply from qwen3-8b')).toBeTruthy();
  });

  it('says who is typing, leaving out the user', () => {
    show(circle(), chatOf([message('One')], { typing: [MAYA, ME] }));
    expect(screen.getByText('Maya is typing…')).toBeTruthy();
  });

  it('shows who has read up to the newest message, and nothing for an older read', () => {
    const one = message('One', { author: ME, name: 'Ada', mine: true });
    const two = message('Two', { author: ME, name: 'Ada', mine: true });
    const { unmount } = show(circle(), chatOf([one, two], { seenBy: { [MAYA]: { author: ME, id: two.id } } }));
    expect(screen.getByLabelText('Seen by Maya while you were online')).toBeTruthy();
    unmount();
    show(circle(), chatOf([one, two], { seenBy: { [MAYA]: { author: ME, id: one.id } } }));
    expect(screen.queryByText('Seen')).toBeNull();
  });

  it('tells members the user is typing once there is text', () => {
    const chat = chatOf([]);
    show(circle(), chat);
    const box = screen.getByRole('textbox', { name: 'Message Book club' });
    fireEvent.change(box, { target: { value: ' ' } });
    expect(chat.notifyTyping).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: 'Hi' } });
    expect(chat.notifyTyping).toHaveBeenCalledTimes(1);
  });

  it('marks the newest message read', () => {
    const chat = chatOf([message('One'), message('Two')]);
    show(circle(), chat);
    expect(chat.markRead).toHaveBeenLastCalledWith(chat.messages[1]);
  });

  it('starts an empty channel with who can read it, and locks the composer while joining', () => {
    show(circle({ writable: false }), chatOf([]));
    expect(screen.getByText('This is the start of General')).toBeTruthy();
    const box = screen.getByRole('textbox', { name: 'Message Book club' }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe('This Mac is still joining this Circle');
  });
});

describe('CircleThread compact', () => {
  afterEach(cleanup);
  const channels = [
    { id: 'general', name: 'General', unread: 0 },
    { id: 'garden', name: 'Garden', unread: 4 },
  ];

  it('swaps the header controls for a channel picker and drops the hint', () => {
    const onOpenChannel = vi.fn();
    render(
      <CircleThread
        compact
        circle={circle()}
        channel={channels[0]}
        channels={channels}
        onOpenChannel={onOpenChannel}
        chat={chatOf([message('Hello')])}
        headerEnd={<button type="button">Panel</button>}
      />
    );
    expect(screen.queryByRole('button', { name: 'Panel' })).toBeNull();
    expect(screen.queryByText(/gets a copy/)).toBeNull();
    expect(screen.getByText('2 people · 2 online')).toBeTruthy();
    const picker = screen.getByRole('combobox', { name: 'Channel' });
    expect(within(picker).getByRole('option', { name: 'Garden (4)' })).toBeTruthy();
    fireEvent.change(picker, { target: { value: 'garden' } });
    expect(onOpenChannel).toHaveBeenCalledWith('garden');
  });

  it('keeps message actions behind …', () => {
    render(<CircleThread compact circle={circle()} channel={channels[0]} chat={chatOf([message('Mine', { author: ME, name: 'Ada', mine: true })])} />);
    expect(within(row('Mine')).queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(within(row('Mine')).getByRole('button', { name: 'Message actions' }));
    expect(within(row('Mine')).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(row('Mine')).getByRole('button', { name: 'Delete' })).toBeTruthy();
  });
});

describe('placing chat updates', () => {
  const a = message('A');
  const b = message('B', { confirmed: false });
  const update = (extra: object) => ({ circleKey: a.circleKey, channel: 'general', added: [], changed: [], gone: [], ...extra });

  it('appends new messages once and replaces changed ones', () => {
    const c = message('C');
    expect(applyChatUpdate([a, b], update({ added: [c, a] }))).toEqual([a, b, c]);
    const edited = { ...a, text: 'A2', edited: true };
    expect(applyChatUpdate([a, b], update({ changed: [edited] }))).toEqual([edited, b]);
  });

  it('asks for a fresh read when a message is gone, confirmed or not loaded', () => {
    expect(applyChatUpdate([a, b], update({ gone: [{ author: b.author, id: b.id }] }))).toBeNull();
    expect(applyChatUpdate([a, b], update({ changed: [{ ...b, confirmed: true }] }))).toBeNull();
    expect(applyChatUpdate([a], update({ changed: [b] }))).toBeNull();
  });

  it('keeps older messages ahead of a fresh tail', () => {
    const c = message('C');
    expect(mergeTail([a, b, c], [{ ...c, confirmed: true }])).toEqual([a, b, { ...c, confirmed: true }]);
    expect(mergeTail([a, b], [c])).toEqual([c]);
    expect(mergeTail([a], [])).toEqual([]);
  });
});
