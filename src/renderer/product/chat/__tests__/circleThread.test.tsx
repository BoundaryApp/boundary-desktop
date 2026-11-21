import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CircleChatUpdate,
  CircleReaction,
  CircleMessage,
  CircleSnapshot,
} from '../../../../shared/types/circles';
import { ME, circleMember, circleSnapshot } from '../../../__tests__/circleFixtures';
import { installElectronAPI, stubElectronAPI } from '../../../__tests__/electronApiFake';
import { CircleThread } from '../circle/CircleThread';
import { flushMenu, openMenu } from '../../../__tests__/openMenu';
import { applyChatUpdate, mergeTail, useCircleChat, type CircleChatView } from '../../circles/useCircleChat';

// The real picker needs layout (ResizeObserver, row heights) that jsdom lacks. Its data and Frimousse
// wiring are covered by emojiData.test.ts; here only what CircleThread does with a pick.
vi.mock('../circle/EmojiPickerSheet', () => ({
  default: ({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="Add a reaction">
      {['🎉', '👍', 'ab'].map((emoji) => (
        <button key={emoji} type="button" onClick={() => onPick(emoji)}>
          {`pick ${emoji}`}
        </button>
      ))}
      <button type="button" onClick={onClose}>
        close picker
      </button>
    </div>
  ),
}));

const MAYA = 'bb'.repeat(32);
const MARCUS = 'ee'.repeat(32);
const SAM = 'dd'.repeat(32);
const AT = Date.UTC(2026, 10, 3, 9, 12);

const ada = circleMember({ identity: ME, name: 'Ada', isMe: true });
const maya = circleMember({ identity: MAYA, name: 'Maya', role: 'admin' });
const circle = (extra: Partial<CircleSnapshot> = {}): CircleSnapshot => circleSnapshot({ name: 'Book club', members: [ada, maya], ...extra });

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
  mentions: null,
  reply: null,
  reactions: [],
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
    react: vi.fn(async () => null),
    seen: 0,
    markRead: vi.fn(),
    typing: [],
    seenBy: {},
    notifyTyping: vi.fn(),
    ...extra,
  };
}

const show = (snapshot: CircleSnapshot, chat: CircleChatView) =>
  render(<CircleThread circle={snapshot} channel={{ id: 'general', name: 'General' }} chat={chat} />);

// By text content, so a message whose mentions are wrapped in elements is still found.
const row = (text: string): HTMLElement => {
  const found = Array.from(document.querySelectorAll<HTMLElement>('.wb-circle-msg')).find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`No message contains "${text}"`);
  return found;
};

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

  it('offers Edit and Delete only on the user’s own message, admins included', () => {
    for (const myRole of ['member', 'admin'] as const) {
      const { unmount } = show(circle({ myRole }), chatOf([message('Hers'), message('Mine', { author: ME, name: 'Ada', mine: true })]));
      expect(within(row('Hers')).queryByRole('button', { name: 'Delete' })).toBeNull();
      expect(within(row('Hers')).queryByRole('button', { name: 'Edit' })).toBeNull();
      expect(within(row('Mine')).getByRole('button', { name: 'Edit' })).toBeTruthy();
      expect(within(row('Mine')).getByRole('button', { name: 'Delete' })).toBeTruthy();
      unmount();
    }
  });

  it('puts the toolbar inside the message line, so the line anchors it below any day divider', () => {
    show(circle(), chatOf([message('Hers'), message('Mine', { author: ME, name: 'Ada', mine: true })]));
    for (const text of ['Hers', 'Mine']) {
      const bar = within(row(text)).getByRole('toolbar', { name: 'Message actions' });
      expect(bar.parentElement?.classList.contains('wb-circle-line')).toBe(true);
      expect(within(bar).getByRole('button', { name: 'Copy' })).toBeTruthy();
    }
  });

  it('fills only a live own message’s bubble, and swaps the bubble for the editor', () => {
    show(
      circle(),
      chatOf([
        message('Mine', { author: ME, name: 'Ada', mine: true }),
        message('', { author: ME, name: 'Ada', mine: true, deleted: 'author' }),
      ])
    );
    expect(screen.getByText('Mine').closest('.wb-bubble')?.classList.contains('is-gone')).toBe(false);
    expect(screen.getByText('Deleted').closest('.wb-bubble')?.classList.contains('is-gone')).toBe(true);
    fireEvent.click(within(row('Mine')).getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Edit message' }).closest('.wb-bubble')).toBeNull();
  });

  it('edits in place and deletes after the dialog', async () => {
    const mine = message('Draft', { author: ME, name: 'Ada', mine: true });
    const chat = chatOf([mine]);
    show(circle(), chat);
    fireEvent.click(within(row('Draft')).getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    fireEvent.change(box, { target: { value: 'Final' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(chat.edit).toHaveBeenCalledWith(mine.id, 'Final', [], false));

    fireEvent.click(within(row('Draft')).getByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/Every member’s Mac still holds the Circle’s history, so it isn’t erased/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(chat.remove).toHaveBeenCalledWith({ author: ME, id: mine.id }));
  });

  it('says so when messages are unconfirmed and no admin is online', () => {
    const offline = circle({
      members: [
        ada,
        { ...maya, online: false },
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
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const chat = chatOf([message('One'), message('Two')]);
    show(circle(), chat);
    expect(chat.markRead).toHaveBeenLastCalledWith(chat.messages[1]);
    focused.mockRestore();
  });

  it('leaves a message unread while the window is unfocused, and marks the newest on focus', () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const first = chatOf([message('One')]);
    const { rerender } = show(circle(), first);
    // A message arrives while the channel is open in a visible but unfocused window.
    const second = chatOf([...first.messages, message('Two')], { markRead: first.markRead });
    rerender(<CircleThread circle={circle()} channel={{ id: 'general', name: 'General' }} chat={second} />);
    expect(first.markRead).not.toHaveBeenCalled();
    focused.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(first.markRead).toHaveBeenCalledTimes(1);
    expect(first.markRead).toHaveBeenLastCalledWith(second.messages[1]);
    focused.mockRestore();
  });

  it('marks the channel read again when a reaction arrives in an open, focused channel', () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const first = chatOf([message('One')], { seen: 0 });
    const { rerender } = show(circle(), first);
    expect(first.markRead).toHaveBeenCalledTimes(1);
    const reacted = chatOf(first.messages, { markRead: first.markRead, seen: 5000 });
    rerender(<CircleThread circle={circle()} channel={{ id: 'general', name: 'General' }} chat={reacted} />);
    expect(first.markRead).toHaveBeenCalledTimes(2);
    focused.mockRestore();
  });

  it('holds a reaction unread while the window is unfocused, and marks it on focus', () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const first = chatOf([message('One')], { seen: 0 });
    const { rerender } = show(circle(), first);
    const reacted = chatOf(first.messages, { markRead: first.markRead, seen: 5000 });
    rerender(<CircleThread circle={circle()} channel={{ id: 'general', name: 'General' }} chat={reacted} />);
    expect(first.markRead).not.toHaveBeenCalled();
    focused.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(first.markRead).toHaveBeenCalledTimes(1);
    focused.mockRestore();
  });

  it('starts an empty channel with who can read it, and locks the composer while joining', () => {
    show(circle({ writable: false }), chatOf([]));
    expect(screen.getByText('This is the start of General')).toBeTruthy();
    const box = screen.getByRole('textbox', { name: 'Message Book club' }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe('This Mac is still joining this Circle');
  });
});

const reaction = (emoji: string, people: { identity: string; name: string }[], mine = false): CircleReaction => ({
  emoji,
  count: people.length,
  mine,
  people: people.map((person, index) => ({ ...person, left: false, at: AT + index })),
});

describe('CircleThread reactions', () => {
  afterEach(cleanup);

  it('shows pills in order with counts and marks mine', () => {
    show(
      circle(),
      chatOf([
        message('Chapter 3?', {
          reactions: [
            reaction('👍', [{ identity: ME, name: 'Ada' }, { identity: MAYA, name: 'Maya' }], true),
            reaction('🎉', [{ identity: MAYA, name: 'Maya' }]),
          ],
        }),
      ])
    );
    const pills = within(within(row('Chapter 3?')).getByRole('group', { name: 'Reactions' })).getAllByRole('button');
    expect(pills.map((pill) => pill.textContent)).toEqual(['👍2', '🎉1']);
    expect(pills.every((pill) => pill.getAttribute('data-slot') === 'chip')).toBe(true);
    expect(pills[0].getAttribute('aria-pressed')).toBe('true');
    expect(pills[0].getAttribute('aria-label')).toBe('👍 2, You and Maya');
    expect(pills[1].getAttribute('aria-pressed')).toBe('false');
  });

  it('puts pills under the body of others’ messages and under the user’s own bubble', () => {
    show(
      circle(),
      chatOf([
        message('Hers', { reactions: [reaction('👍', [{ identity: MAYA, name: 'Maya' }])] }),
        message('Mine', { author: ME, name: 'Ada', mine: true, reactions: [reaction('👍', [{ identity: MAYA, name: 'Maya' }])] }),
      ])
    );
    expect(within(row('Hers')).getByRole('group', { name: 'Reactions' }).closest('.wb-circle-m')).toBeTruthy();
    expect(within(row('Mine')).getByRole('group', { name: 'Reactions' }).parentElement?.classList.contains('wb-circle-line')).toBe(true);
  });

  it('clicking a pill toggles my reaction', () => {
    const chat = chatOf([
      message('Hers', {
        reactions: [
          reaction('👍', [{ identity: ME, name: 'Ada' }], true),
          reaction('🎉', [{ identity: MAYA, name: 'Maya' }]),
        ],
      }),
    ]);
    show(circle(), chat);
    const target = chat.messages[0];
    fireEvent.click(within(row('Hers')).getByRole('button', { name: /^🎉 1/ }));
    expect(chat.react).toHaveBeenCalledWith({ author: target.author, id: target.id }, '🎉', true);
    fireEvent.click(within(row('Hers')).getByRole('button', { name: /^👍 1/ }));
    expect(chat.react).toHaveBeenCalledWith({ author: target.author, id: target.id }, '👍', false);
  });

  it('shows a failed reaction the way the thread shows other failures', async () => {
    const chat = chatOf([message('Hers', { reactions: [reaction('🎉', [{ identity: MAYA, name: 'Maya' }])] })], {
      react: vi.fn(async () => 'That message was deleted.'),
    });
    show(circle(), chat);
    fireEvent.click(within(row('Hers')).getByRole('button', { name: /^🎉 1/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('That message was deleted.');
  });

  it('shows a rejected react as an error', async () => {
    const chat = chatOf([message('Hers', { reactions: [reaction('🎉', [{ identity: MAYA, name: 'Maya' }])] })], {
      react: vi.fn(async () => {
        throw new Error('Offline.');
      }),
    });
    show(circle(), chat);
    fireEvent.click(within(row('Hers')).getByRole('button', { name: /^🎉 1/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Offline.');
  });

  it('ignores a late result after a channel switch or from an older click', async () => {
    const pending: ((value: string | null) => void)[] = [];
    const chat = chatOf([message('Hers', { reactions: [reaction('🎉', [{ identity: MAYA, name: 'Maya' }])] })], {
      react: vi.fn(() => new Promise<string | null>((resolve) => pending.push(resolve))),
    });
    const view = show(circle(), chat);
    const click = () => fireEvent.click(within(row('Hers')).getByRole('button', { name: /^🎉 1/ }));
    click();
    click();
    await act(async () => pending[0]('First failed.'));
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => pending[1]('Second failed.'));
    expect(screen.getByRole('alert').textContent).toContain('Second failed.');
    click();
    view.rerender(<CircleThread circle={circle()} channel={{ id: 'other', name: 'Other' }} chat={chat} />);
    await act(async () => pending[2]('Late failure.'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lays the picks out in a wrapping row and keeps the toolbar up while the picker is open', async () => {
    show(circle(), chatOf([message('Hers')]));
    openMenu(within(row('Hers')).getByRole('button', { name: 'React' }));
    await flushMenu();
    expect(screen.getByRole('menu', { name: 'React' }).className).toContain('flex-wrap');
    const css = readFileSync(resolve(__dirname, '../circle/circleChat.css'), 'utf8');
    expect(css).toContain(".wb-circle-bar:has(.wb-react-wrap [data-slot='menu-content'])");
  });

  it('moves between picks with Left and Right as well as Up and Down, wrapping at the ends', async () => {
    show(circle(), chatOf([message('Hers')]));
    openMenu(within(row('Hers')).getByRole('button', { name: 'React' }));
    await flushMenu();
    const menu = screen.getByRole('menu', { name: 'React' });
    const picks = within(menu).getAllByRole('menuitemcheckbox');
    const more = within(menu).getByRole('menuitem', { name: 'More emoji' });
    picks[0].focus();
    fireEvent.keyDown(picks[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(picks[1]);
    fireEvent.keyDown(picks[1], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(picks[0]);
    fireEvent.keyDown(picks[0], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(more, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(picks[0]);
    fireEvent.keyDown(picks[0], { key: 'ArrowDown' });
    await flushMenu();
    expect(document.activeElement).toBe(picks[1]);
  });

  it('the React popover adds a quick pick and takes back one I have', async () => {
    const chat = chatOf([message('Hers', { reactions: [reaction('❤️', [{ identity: ME, name: 'Ada' }], true)] })]);
    show(circle(), chat);
    const target = chat.messages[0];
    const open = within(row('Hers')).getByRole('button', { name: 'React' });
    expect(within(row('Hers')).getAllByRole('button').indexOf(open)).toBeLessThan(
      within(row('Hers')).getAllByRole('button').indexOf(within(row('Hers')).getByRole('button', { name: 'Copy' }))
    );
    expect(open.getAttribute('aria-haspopup')).toBe('menu');
    openMenu(open);
    await flushMenu();
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitemcheckbox');
    expect(items.map((item) => item.textContent)).toEqual(['👍', '❤️', '😂', '😮', '😢', '🙏']);
    expect(items[1].getAttribute('aria-checked')).toBe('true');
    expect(items[0].getAttribute('aria-checked')).toBe('false');
    expect(within(menu).getByRole('menuitem', { name: 'More emoji' })).toBeTruthy();
    fireEvent.click(items[0]);
    expect(chat.react).toHaveBeenCalledWith({ author: target.author, id: target.id }, '👍', true);
    await flushMenu();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(open);
    openMenu(open);
    await flushMenu();
    fireEvent.click(within(screen.getByRole('menu')).getAllByRole('menuitemcheckbox')[1]);
    expect(chat.react).toHaveBeenCalledWith({ author: target.author, id: target.id }, '❤️', false);
  });

  it('More emoji opens the picker and picking adds the reaction', async () => {
    const chat = chatOf([message('Hers', { reactions: [reaction('👍', [{ identity: ME, name: 'Ada' }], true)] })]);
    show(circle(), chat);
    const target = chat.messages[0];
    const more = async () => {
      openMenu(within(row('Hers')).getByRole('button', { name: 'React' }));
      await flushMenu();
      fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'More emoji' }));
      expect(screen.queryByRole('menu')).toBeNull();
      return screen.findByRole('dialog', { name: 'Add a reaction' });
    };
    fireEvent.click(within(await more()).getByRole('button', { name: 'pick 🎉' }));
    expect(chat.react).toHaveBeenCalledWith({ author: target.author, id: target.id }, '🎉', true);
    expect(screen.queryByRole('dialog', { name: 'Add a reaction' })).toBeNull();
    // Same as a quick pick: an emoji already mine is taken back.
    fireEvent.click(within(await more()).getByRole('button', { name: 'pick 👍' }));
    expect(chat.react).toHaveBeenLastCalledWith({ author: target.author, id: target.id }, '👍', false);
    // A string that is not one emoji never reaches main.
    vi.mocked(chat.react).mockClear();
    fireEvent.click(within(await more()).getByRole('button', { name: 'pick ab' }));
    expect(chat.react).not.toHaveBeenCalled();
    fireEvent.click(within(await more()).getByRole('button', { name: 'close picker' }));
    expect(screen.queryByRole('dialog', { name: 'Add a reaction' })).toBeNull();
    expect(chat.react).not.toHaveBeenCalled();
  });

  it('closes the popover on Escape, returning focus, and on an outside click', async () => {
    show(circle(), chatOf([message('Hers')]));
    const open = within(row('Hers')).getByRole('button', { name: 'React' });
    openMenu(open);
    await flushMenu();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await flushMenu();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(open);
    openMenu(open);
    await flushMenu();
    fireEvent.pointerDown(document.body);
    await flushMenu();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('at 20 reactions the popover says so and adds nothing new', async () => {
    const many = Array.from({ length: 20 }, (_, index) => reaction(String.fromCodePoint(0x1f600 + index), [{ identity: ME, name: 'Ada' }], true));
    many[0] = reaction('👍', [{ identity: ME, name: 'Ada' }], true);
    const chat = chatOf([message('Hers', { reactions: many })]);
    show(circle(), chat);
    openMenu(within(row('Hers')).getByRole('button', { name: 'React' }));
    await flushMenu();
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('You’ve used 20 reactions on this message')).toBeTruthy();
    const items = within(menu).getAllByRole('menuitemcheckbox');
    const [thumbs, heart] = [items[0], items[1]];
    expect(thumbs.getAttribute('aria-disabled')).toBeNull();
    expect(heart.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(heart);
    expect(chat.react).not.toHaveBeenCalled();
    fireEvent.click(thumbs);
    expect(chat.react).toHaveBeenCalledTimes(1);
  });

  it('a deleted message has no pills and no React', () => {
    show(circle(), chatOf([message('', { deleted: 'author', reactions: [reaction('👍', [{ identity: MAYA, name: 'Maya' }])] })]));
    expect(screen.queryByRole('group', { name: 'Reactions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'React' })).toBeNull();
  });

  it('a departed reactor is listed as left, from the current member list', () => {
    const sam = { identity: SAM, name: 'Sam' };
    show(circle(), chatOf([message('Hers', { reactions: [reaction('👍', [{ identity: ME, name: 'Ada' }, { identity: MAYA, name: 'Maya' }, sam], true)] })]));
    const pill = within(row('Hers')).getByRole('button', { name: '👍 3, You, Maya and Sam' });
    expect(pill.getAttribute('data-tip')).toBe('You, Maya and Sam (left)');
  });

  it('names a current member from the member list, not from the name in their record', () => {
    show(circle(), chatOf([message('Hers', { reactions: [reaction('👍', [{ identity: MAYA, name: 'Ada' }])] })]));
    const pill = within(row('Hers')).getByRole('button', { name: '👍 1, Maya' });
    expect(pill.getAttribute('data-tip')).toBe('Maya');
  });

  it('shows the stored name for a departed reactor, tagged left', () => {
    show(circle(), chatOf([message('Hers', { reactions: [reaction('👍', [{ identity: SAM, name: 'Sam' }])] })]));
    const pill = within(row('Hers')).getByRole('button', { name: '👍 1, Sam' });
    expect(pill.getAttribute('data-tip')).toBe('Sam (left)');
  });
});

describe('CircleThread select mode', () => {
  afterEach(cleanup);
  const admin = () => circle({ myRole: 'admin' });
  const select = (snapshot: CircleSnapshot, chat: CircleChatView, onStopSelecting = vi.fn()) => {
    render(
      <CircleThread
        circle={snapshot}
        channel={{ id: 'general', name: 'General' }}
        chat={chat}
        selecting
        onStopSelecting={onStopSelecting}
      />
    );
    return onStopSelecting;
  };
  const box = (text: string) => within(row(text)).getByRole('checkbox') as HTMLInputElement;

  it('puts a checkbox on every live message, hides the toolbar and swaps the composer for a Remove bar', () => {
    select(
      admin(),
      chatOf([message('Hers'), message('Mine', { author: ME, name: 'Ada', mine: true }), message('', { deleted: 'admin' })])
    );
    expect(box('Hers').checked).toBe(false);
    expect(box('Mine').checked).toBe(false);
    expect(within(row('Removed by an admin')).queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('toolbar', { name: 'Message actions' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Message Book club' })).toBeNull();
    expect(screen.getByText('Select messages to remove')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('toggles a message from its checkbox or anywhere on its line, and counts them', () => {
    select(admin(), chatOf([message('Hers'), message('Again')]));
    fireEvent.click(box('Hers'));
    expect(box('Hers').checked).toBe(true);
    fireEvent.click(row('Again').querySelector('.wb-circle-line') as HTMLElement);
    expect(box('Again').checked).toBe(true);
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.click(row('Again').querySelector('.wb-circle-line') as HTMLElement);
    expect(box('Again').checked).toBe(false);
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('removes every selected message after the dialog, then leaves select mode', async () => {
    const hers = message('Hers');
    const mine = message('Mine', { author: ME, name: 'Ada', mine: true });
    const chat = chatOf([hers, message('Keep'), mine]);
    const stop = select(admin(), chat);
    fireEvent.click(box('Hers'));
    fireEvent.click(box('Mine'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Remove 2 messages?')).toBeTruthy();
    expect(within(dialog).getByText(/Every member’s Mac still holds the Circle’s history, so they aren’t erased/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(chat.remove).toHaveBeenCalledTimes(2);
    expect(chat.remove).toHaveBeenCalledWith({ author: MAYA, id: hers.id });
    expect(chat.remove).toHaveBeenCalledWith({ author: ME, id: mine.id });
  });

  it('keeps the messages that failed selected and says why', async () => {
    const one = message('One');
    const two = message('Two');
    const remove = vi.fn(async (ref: { id: string }) => (ref.id === two.id ? 'This Mac is offline' : null));
    const stop = select(admin(), chatOf([one, two], { remove }));
    fireEvent.click(box('One'));
    fireEvent.click(box('Two'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(await within(screen.getByRole('dialog')).findByText('1 of 2 wasn’t removed: This Mac is offline')).toBeTruthy();
    expect(stop).not.toHaveBeenCalled();
    expect(box('One').checked).toBe(false);
    expect(box('Two').checked).toBe(true);
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('leaves select mode on Cancel and on Escape', () => {
    const stop = select(admin(), chatOf([message('Hers')]));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(stop).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('shows a member no checkboxes, even when asked to select', () => {
    select(circle(), chatOf([message('Hers')]));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message Book club' })).toBeTruthy();
  });

  it('hides React and makes a pill pick the line instead of reacting', () => {
    const chat = chatOf([message('Hers', { reactions: [reaction('👍', [{ identity: MAYA, name: 'Maya' }])] })]);
    select(admin(), chat);
    expect(within(row('Hers')).queryByRole('button', { name: 'React' })).toBeNull();
    const pill = within(row('Hers')).getByRole('button', { name: '👍 1, Maya' });
    expect(pill.hasAttribute('disabled')).toBe(true);
    // A disabled button takes no click in the app; CSS lets the click through to the line.
    fireEvent.click(pill.parentElement as HTMLElement);
    expect(chat.react).not.toHaveBeenCalled();
    expect(box('Hers').checked).toBe(true);
  });
});

describe('CircleThread mentions', () => {
  afterEach(cleanup);
  const SAM_NAME = 'Dr. Sam (he/him)';
  const people = circle({
    members: [ada, maya, circleMember({ identity: SAM, name: SAM_NAME }), circleMember({ identity: MARCUS, name: 'Joanna' })],
  });
  const aimed = (members: string[], channel = false) => ({ members, channel });

  it('fills a message that mentions the user and bolds their name', () => {
    show(people, chatOf([message('@Ada can you host?', { mentions: aimed([ME]) })]));
    const mentioned = row('can you host?');
    expect(mentioned.className).toContain('is-mentioned');
    const at = mentioned.querySelector('.wb-circle-at.is-me');
    expect(at?.textContent).toBe('@Ada');
  });

  it('fills a message that replies to the user, but not one replying to someone else', () => {
    show(
      people,
      chatOf([
        message('Yes I can', { reply: { author: ME, id: 'a'.repeat(16) } }),
        message('Sounds good', { author: SAM, name: SAM_NAME, reply: { author: MAYA, id: 'b'.repeat(16) } }),
      ])
    );
    expect(row('Yes I can').className).toContain('is-mentioned');
    expect(row('Sounds good').className).not.toContain('is-mentioned');
  });

  it('marks a mention of someone else without filling the row', () => {
    show(people, chatOf([message('Is @Maya bringing wine?', { author: SAM, name: SAM_NAME, mentions: aimed([MAYA]) })]));
    const other = row('bringing wine?');
    expect(other.className).not.toContain('is-mentioned');
    const at = other.querySelector('.wb-circle-at');
    expect(at?.textContent).toBe('@Maya');
    expect(at?.className).not.toContain('is-me');
  });

  it('wraps a name with punctuation as one element', () => {
    show(people, chatOf([message(`hello @${SAM_NAME} there`, { mentions: aimed([SAM]) })]));
    const marks = document.querySelectorAll('.wb-circle-at');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe(`@${SAM_NAME}`);
  });

  it('wraps @channel, and fills the row only when the user takes channel mentions', () => {
    const view = chatOf([message('@channel call at 7?', { mentions: aimed([], true) })]);
    const { unmount } = render(
      <CircleThread circle={people} channel={{ id: 'general', name: 'General' }} chat={view} channelMentions />
    );
    expect(document.querySelector('.wb-circle-at')?.textContent).toBe('@channel');
    expect(row('call at 7?').className).toContain('is-mentioned');
    unmount();
    show(people, view);
    expect(document.querySelector('.wb-circle-at')?.textContent).toBe('@channel');
    expect(row('call at 7?').className).not.toContain('is-mentioned');
  });

  it('does not mark the user’s own post as mentioning them', () => {
    show(
      people,
      chatOf([message('@Ada @channel own post', { author: ME, name: 'Ada', mine: true, mentions: aimed([ME], true) })]),
    );
    expect(row('own post').className).not.toContain('is-mentioned');
    expect(row('own post').querySelector('.wb-circle-at.is-me')?.textContent).toBe('@Ada');
  });

  it('gives each message in one thread its own mention marks', () => {
    show(
      people,
      chatOf([
        message('first hi @Maya', { mentions: aimed([MAYA]) }),
        message('second hi @Joanna', { mentions: aimed([MARCUS]) }),
      ]),
    );
    expect(row('first hi').querySelector('.wb-circle-at')?.textContent).toBe('@Maya');
    expect(row('second hi').querySelector('.wb-circle-at')?.textContent).toBe('@Joanna');
  });

  it('names the current name of a listed person whose name is not in the text', () => {
    show(people, chatOf([message('Ask @Jo, they had the list.', { mentions: aimed([MARCUS]) })]));
    expect(screen.getByText('Mentioned: Joanna')).toBeTruthy();
    expect(document.querySelector('.wb-circle-at')).toBeNull();
  });

  it('matches names literally, not as patterns, and never turns text into HTML', () => {
    const odd = circle({ members: [ada, circleMember({ identity: SAM, name: '.*' })] });
    const { container } = show(odd, chatOf([message('@x and @.* <script>1</script> <img src=x onerror=1>', { mentions: aimed([SAM]) })]));
    const marks = container.querySelectorAll('.wb-circle-at');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('@.*');
    expect(container.querySelector('.wb-circle-body script, .wb-circle-body img')).toBeNull();
  });

  it('leaves code alone', () => {
    show(people, chatOf([message('`@Maya` is code', { mentions: aimed([MAYA]) })]));
    expect(document.querySelector('.wb-circle-at')).toBeNull();
    expect(screen.queryByText('Mentioned: Maya')).toBeNull();
  });
});

describe('CircleThread compact', () => {
  afterEach(cleanup);
  const channels = [
    { id: 'general', name: 'General', unread: 0, mentioned: false },
    { id: 'garden', name: 'Garden', unread: 4, mentioned: false },
  ];

  // The desktop panel draws it, where the line keeps it apart from the agent chat (ADR 0058 §8).
  it('swaps the header controls for a channel picker and keeps who gets a copy', () => {
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
    expect(screen.getByText('Everyone in Book club gets a copy')).toBeTruthy();
    expect(screen.getByText('2 people · 2 online')).toBeTruthy();
    const picker = screen.getByRole('combobox', { name: 'Channel' });
    expect(within(picker).getByRole('option', { name: 'Garden (4)' })).toBeTruthy();
    fireEvent.change(picker, { target: { value: 'garden' } });
    expect(onOpenChannel).toHaveBeenCalledWith('garden');
  });

  it('uses the same hover toolbar as the wide layout', () => {
    render(<CircleThread compact circle={circle()} channel={channels[0]} chat={chatOf([message('Mine', { author: ME, name: 'Ada', mine: true })])} />);
    const bar = within(row('Mine')).getByRole('toolbar', { name: 'Message actions' });
    expect(within(bar).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Delete' })).toBeTruthy();
  });
});

describe('placing chat updates', () => {
  const a = message('A');
  const b = message('B', { confirmed: false });
  const update = (extra: Partial<CircleChatUpdate>): CircleChatUpdate => ({
    circleKey: a.circleKey,
    channel: 'general',
    added: [],
    changed: [],
    gone: [],
    ...extra,
  });

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

describe('the @ menu in the Circle composer', () => {
  afterEach(cleanup);
  const marcus = circleMember({ identity: MARCUS, name: 'Marcus', online: false });
  const mentionable = (extra: Partial<CircleSnapshot> = {}) =>
    circle({ format: 3, members: [ada, marcus, maya], ...extra });
  const typeInto = (text: string) => {
    const box = screen.getByRole('textbox', { name: 'Message Book club' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: text } });
    return box;
  };
  const optionTexts = () => screen.getAllByRole('option').map((option) => option.textContent);

  it('lists @channel, then people with those online first, and filters by name', () => {
    show(mentionable(), chatOf([]));
    typeInto('@');
    const texts = optionTexts();
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('@channel');
    expect(texts[0]).toContain('Everyone in this Circle who hasn’t turned it off');
    expect(texts[1]).toContain('Maya');
    expect(texts[1]).toContain('Online');
    expect(texts[2]).toContain('Marcus');
    expect(texts[2]).toContain('Away');
    expect(screen.getByText('People')).toBeTruthy();
    typeInto('@mar');
    expect(optionTexts()).toHaveLength(1);
    expect(optionTexts()[0]).toContain('Marcus');
  });

  it('moves with the arrow keys, picks with Enter and sends the pick', async () => {
    const chat = chatOf([]);
    show(mentionable(), chat);
    const box = typeInto('@');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');
    expect(box.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1].id);
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('@Maya ');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(chat.send).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '@Maya hi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(chat.send).toHaveBeenCalledWith('@Maya hi', [{ identity: MAYA, name: 'Maya' }], false));
  });

  it('closes on Escape and picks with a click', () => {
    show(mentionable(), chatOf([]));
    const box = typeInto('@');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    typeInto('@M');
    fireEvent.click(screen.getAllByRole('option')[1]);
    expect(box.value).toBe('@Marcus ');
  });

  it('sends the @channel flag when @channel was picked', async () => {
    const chat = chatOf([]);
    show(mentionable(), chat);
    const box = typeInto('call at 7? @');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('call at 7? @channel ');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(chat.send).toHaveBeenCalledWith('call at 7? @channel ', [], true));
  });

  it('sends each pick once and nothing for a mention typed by hand', async () => {
    const chat = chatOf([]);
    show(mentionable(), chat);
    const box = typeInto('@Maya hi');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(chat.send).toHaveBeenLastCalledWith('@Maya hi', [], false));
    typeInto('@Ma');
    fireEvent.keyDown(box, { key: 'Enter' });
    typeInto('@Maya and @Ma');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('@Maya and @Maya ');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(chat.send).toHaveBeenLastCalledWith('@Maya and @Maya ', [{ identity: MAYA, name: 'Maya' }], false)
    );
  });

  it('keeps a draft’s picks when the user visits another channel and comes back', async () => {
    const chat = chatOf([]);
    const snapshot = mentionable();
    const view = (id: string) => (
      <CircleThread circle={snapshot} channel={{ id, name: id }} chat={chat} />
    );
    const { rerender } = render(view('general'));
    const box = typeInto('@');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    rerender(view('random'));
    expect(box.value).toBe('');
    rerender(view('general'));
    expect(box.value).toBe('@Maya ');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(chat.send).toHaveBeenCalledWith('@Maya ', [{ identity: MAYA, name: 'Maya' }], false));
  });

  it('leaves Enter to the input method while composing', () => {
    show(mentionable(), chatOf([]));
    const box = typeInto('@');
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(box.value).toBe('@');
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('shows no menu below format 3', () => {
    show(circle({ format: 2 }), chatOf([]));
    typeInto('@');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('editing a message that has mentions', () => {
  afterEach(cleanup);

  it('hands back the mentions the message already has, by each member’s current name', async () => {
    const gone = 'ff'.repeat(32);
    const mine = message('@Maya and @Old, hello', {
      author: ME,
      name: 'Ada',
      mine: true,
      mentions: { members: [MAYA, gone], channel: true },
    });
    const chat = chatOf([mine]);
    show(circle({ format: 3 }), chat);
    fireEvent.click(within(row('@Maya and @Old, hello')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: '@Maya and @Old, hello there' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit message' }), { key: 'Enter' });
    await waitFor(() =>
      expect(chat.edit).toHaveBeenCalledWith(mine.id, '@Maya and @Old, hello there', [{ identity: MAYA, name: 'Maya' }], true)
    );
  });
});

describe('CircleThread replies', () => {
  let chatListener: ((update: CircleChatUpdate) => void) | null = null;
  const chatMessage = vi.fn();
  beforeEach(() => {
    chatListener = null;
    chatMessage.mockReset();
    chatMessage.mockResolvedValue({ success: true, message: null });
    installElectronAPI();
    stubElectronAPI({
      circles: {
        chatMessage,
        onChatEvent: (listener: (update: CircleChatUpdate) => void) => {
          chatListener = listener;
          return () => {
            chatListener = null;
          };
        },
      },
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  const replies = (extra: Partial<CircleSnapshot> = {}) => circle({ format: 3, ...extra });
  const view = (snapshot: CircleSnapshot, chat: CircleChatView, channel = 'general') => (
    <CircleThread circle={snapshot} channel={{ id: channel, name: channel }} chat={chat} />
  );
  const replyButton = (text: string) => within(row(text)).queryByRole('button', { name: 'Reply' });
  const strip = () => screen.queryByRole('group', { name: 'Reply' });
  const composer = () => screen.getByRole('textbox', { name: 'Message Book club' }) as HTMLTextAreaElement;
  const goTo = (text: string) => within(row(text)).queryByRole('button', { name: "Go to Maya's message" });
  const rowOf = (target: CircleMessage) => document.querySelector(`[data-message="${target.author}/${target.id}"]`) as HTMLElement;
  /** Lets pending promises and the renders they cause finish, without timers. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(async () => undefined);
  };

  it('shows Reply only at format 3, and not on a deleted message', () => {
    const { unmount } = show(circle({ format: 2 }), chatOf([message('Hers')]));
    expect(replyButton('Hers')).toBeNull();
    unmount();
    show(replies(), chatOf([message('Hers'), message('Mine', { author: ME, name: 'Ada', mine: true }), message('', { deleted: 'author' })]));
    expect(replyButton('Hers')).toBeTruthy();
    expect(replyButton('Mine')).toBeTruthy();
    expect(replyButton('Deleted')).toBeNull();
  });

  it('starts a reply and sends it', async () => {
    const hers = message('Chapter **3**?\nOr 4');
    const chat = chatOf([hers]);
    show(replies(), chat);
    fireEvent.click(replyButton('Chapter') as HTMLElement);
    const shown = strip() as HTMLElement;
    expect(shown.textContent).toContain('Replying to Maya');
    expect(shown.textContent).toContain('Chapter 3?');
    expect(shown.textContent).not.toContain('Or 4');
    expect(document.activeElement).toBe(composer());
    fireEvent.change(composer(), { target: { value: 'Yes' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(chat.send).toHaveBeenCalledWith('Yes', [], false, { author: MAYA, id: hers.id }));
    await waitFor(() => expect(strip()).toBeNull());
  });

  it('Escape cancels a reply, and so does Cancel reply', () => {
    show(replies(), chatOf([message('Hers')]));
    fireEvent.click(replyButton('Hers') as HTMLElement);
    fireEvent.keyDown(composer(), { key: 'Escape' });
    expect(strip()).toBeNull();
    fireEvent.click(replyButton('Hers') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));
    expect(strip()).toBeNull();
  });

  it('keeps a reply in the channel’s draft', () => {
    const chat = chatOf([message('Hers')]);
    const { rerender } = render(view(replies(), chat));
    fireEvent.click(replyButton('Hers') as HTMLElement);
    rerender(view(replies(), chat, 'design'));
    expect(strip()).toBeNull();
    rerender(view(replies(), chat));
    expect(strip()?.textContent).toContain('Replying to Maya');
  });

  it('quote follows the original', () => {
    const hers = message('First take');
    const reply = message('Agreed', { author: ME, name: 'Ada', mine: true, reply: { author: MAYA, id: hers.id } });
    const { rerender } = render(view(replies(), chatOf([hers, reply])));
    expect(goTo('Agreed')?.textContent).toContain('First take');
    rerender(view(replies(), chatOf([{ ...hers, text: 'Second take', edited: true }, reply])));
    expect(goTo('Agreed')?.textContent).toContain('Second take');
    rerender(view(replies(), chatOf([{ ...hers, text: '', deleted: 'author' }, reply])));
    expect(within(row('Agreed')).getByText('Original message deleted')).toBeTruthy();
    expect(goTo('Agreed')).toBeNull();
    expect(chatMessage).not.toHaveBeenCalled();
  });

  it('quote fills in when the target arrives', async () => {
    const ref = { author: MAYA, id: 'ff'.repeat(8) };
    const reply = message('Agreed', { author: ME, name: 'Ada', mine: true, reply: ref });
    render(view(replies(), chatOf([reply])));
    await settle();
    expect(within(row('Agreed')).getByText('Original message not available')).toBeTruthy();
    expect(goTo('Agreed')).toBeNull();
    expect(chatMessage).toHaveBeenCalledWith({ key: circle().key, channel: 'general', ...ref });
    chatMessage.mockResolvedValue({ success: true, message: message('Late arrival', { id: ref.id }) });
    await act(async () => chatListener?.({ circleKey: circle().key, channel: 'general', added: [], changed: [], gone: [] }));
    await settle();
    expect(goTo('Agreed')?.textContent).toContain('Late arrival');
  });

  it('says the original is not available when the lookup fails, and asks again after a chat event', async () => {
    const ref = { author: MAYA, id: 'ee'.repeat(8) };
    const reply = message('Agreed', { author: ME, name: 'Ada', mine: true, reply: ref });
    chatMessage.mockRejectedValue(new Error('main went away'));
    render(view(replies(), chatOf([reply])));
    await settle();
    expect(within(row('Agreed')).getByText('Original message not available')).toBeTruthy();
    chatMessage.mockResolvedValue({ success: true, message: message('Found later', { id: ref.id }) });
    await act(async () => chatListener?.({ circleKey: circle().key, channel: 'general', added: [], changed: [], gone: [] }));
    await settle();
    expect(goTo('Agreed')?.textContent).toContain('Found later');
  });

  it('keeps the newest answer when an older lookup answers last', async () => {
    const ref = { author: MAYA, id: 'dd'.repeat(8) };
    const reply = message('Agreed', { author: ME, name: 'Ada', mine: true, reply: ref });
    const answers: ((value: unknown) => void)[] = [];
    chatMessage.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    render(view(replies(), chatOf([reply])));
    await settle();
    await act(async () => chatListener?.({ circleKey: circle().key, channel: 'general', added: [], changed: [], gone: [] }));
    await settle();
    expect(answers).toHaveLength(2);
    await act(async () => answers[1]({ success: true, message: message('Newer text', { id: ref.id }) }));
    await act(async () => answers[0]({ success: true, message: null }));
    await settle();
    expect(goTo('Agreed')?.textContent).toContain('Newer text');
  });

  it('goes to the original, loading older pages', async () => {
    vi.useFakeTimers();
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const target = message('Way back');
    const older = message('Older');
    const reply = message('Agreed', { author: ME, name: 'Ada', mine: true, reply: { author: MAYA, id: target.id } });
    chatMessage.mockResolvedValue({ success: true, message: target });
    const loadOlder = vi.fn(async () => {
      const next = loadOlder.mock.calls.length === 1 ? [older, reply] : [target, older, reply];
      rerender(view(replies(), chatOf(next, { more: true, loadOlder })));
    });
    const { rerender } = render(view(replies(), chatOf([reply], { more: true, loadOlder })));
    await settle();
    fireEvent.click(goTo('Agreed') as HTMLElement);
    await settle();
    expect(loadOlder).toHaveBeenCalledTimes(2);
    expect(rowOf(target).classList.contains('is-highlighted')).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    act(() => void vi.advanceTimersByTime(2000));
    expect(rowOf(target).classList.contains('is-highlighted')).toBe(false);
  });

  it('says the original is not available when no older page has it', async () => {
    const target = message('Way back');
    const reply = message('Agreed', { author: ME, name: 'Ada', mine: true, reply: { author: MAYA, id: target.id } });
    chatMessage.mockResolvedValue({ success: true, message: target });
    const chat = chatOf([reply], { more: false });
    const { rerender } = render(view(replies(), chat));
    await settle();
    fireEvent.click(goTo('Agreed') as HTMLElement);
    await settle();
    expect(chat.loadOlder).not.toHaveBeenCalled();
    expect(within(row('Agreed')).getByText('Original message not available')).toBeTruthy();
    expect(goTo('Agreed')).toBeNull();
    // An update that brings the original fills the quote in again.
    rerender(view(replies(), chatOf([target, reply])));
    expect(goTo('Agreed')?.textContent).toContain('Way back');
  });
});

describe('useCircleChat sends and edits', () => {
  const circles = {
    chatMessages: vi.fn(async () => ({ success: true, messages: [], more: false })),
    chatPost: vi.fn(async () => ({ success: true })),
    chatEdit: vi.fn(async () => ({ success: true })),
    onChatEvent: vi.fn((): (() => void) => () => undefined),
    onChatPresence: vi.fn((): (() => void) => () => undefined),
  };
  afterEach(() => vi.clearAllMocks());

  it('passes picks and the @channel flag to main, and omits them when there are none', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { circles };
    const { result } = renderHook(() => useCircleChat('cc'.repeat(32), 'general'));
    const picked = [{ identity: MAYA, name: 'Maya' }];
    await result.current.send('@Maya hi', picked, true);
    expect(circles.chatPost).toHaveBeenLastCalledWith({
      key: 'cc'.repeat(32), channel: 'general', text: '@Maya hi', picked, mentionChannel: true,
    });
    await result.current.send('plain');
    expect(circles.chatPost).toHaveBeenLastCalledWith({ key: 'cc'.repeat(32), channel: 'general', text: 'plain' });
    await result.current.edit('0001', '@Maya hi', picked, false);
    expect(circles.chatEdit).toHaveBeenLastCalledWith({
      key: 'cc'.repeat(32), channel: 'general', id: '0001', text: '@Maya hi', picked, mentionChannel: false,
    });
  });
});

describe('CircleThread links', () => {
  beforeEach(() => {
    installElectronAPI();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const link = (name: string) => within(row('See')).getByRole('button', { name });

  it('makes a bare URL and a Markdown link clickable', () => {
    show(circle(), chatOf([message('See https://example.com/a and [the notes](https://example.com/notes)')]));
    expect(link('https://example.com/a')).toBeTruthy();
    expect(link('the notes')).toBeTruthy();
  });

  it('asks before opening, outside the bubble, and opens in the browser on confirm', async () => {
    const api = stubElectronAPI({ urls: { openUrl: vi.fn(async () => ({ success: true })) } });
    show(circle(), chatOf([message('See https://example.com/a', { author: ME, name: 'Ada', mine: true })]));
    fireEvent.click(link('https://example.com/a'));
    const dialog = screen.getByRole('dialog', { name: 'Open this link in your browser?' });
    expect(dialog.closest('.wb-circle-msg')).toBeNull();
    expect(within(dialog).getByText('https://example.com/a')).toBeTruthy();
    expect(api.urls.openUrl).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open in browser' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.urls.openUrl).toHaveBeenCalledWith('https://example.com/a');
  });

  it('closes on Cancel without opening anything', () => {
    const api = stubElectronAPI({ urls: { openUrl: vi.fn(async () => ({ success: true })) } });
    show(circle(), chatOf([message('See https://example.com/a')]));
    fireEvent.click(link('https://example.com/a'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.urls.openUrl).not.toHaveBeenCalled();
  });

  it('copies the URL and says Copied for two seconds', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    show(circle(), chatOf([message('See https://example.com/a')]));
    fireEvent.click(link('https://example.com/a'));
    const dialog = screen.getByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy URL' }));
    });
    expect(writeText).toHaveBeenCalledWith('https://example.com/a');
    expect(within(dialog).getByRole('button', { name: 'Copied' })).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(within(dialog).getByRole('button', { name: 'Copy URL' })).toBeTruthy();
  });

  it('keeps the sheet open with the reason when the link can’t be opened', async () => {
    stubElectronAPI({ urls: { openUrl: vi.fn(async () => ({ success: false, error: 'Only http and https links can be opened.' })) } });
    show(circle(), chatOf([message('See [mail me](mailto:maya@example.com)')]));
    fireEvent.click(link('mail me'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Open in browser' }));
    expect(await screen.findByText('Only http and https links can be opened.')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('editing a message, then Escape', () => {
  afterEach(cleanup);

  // Review: in the desktop panel, an Escape the edit box doesn't claim also closes the panel.
  it('cancels the edit and claims the key', () => {
    render(<CircleThread circle={circle()} channel={{ id: 'general', name: 'General' }} chat={chatOf([message('Mine', { author: ME, name: 'Ada', mine: true })])} />);
    fireEvent.click(within(within(row('Mine')).getByRole('toolbar', { name: 'Message actions' })).getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => void box.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(screen.queryByRole('textbox', { name: 'Edit message' })).toBeNull();
  });
});
