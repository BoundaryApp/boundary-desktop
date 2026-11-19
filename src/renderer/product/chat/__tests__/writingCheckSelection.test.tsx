import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeBridge, FakeHermesChat } from '../../../__tests__/fakeBridge';
import { HostedChatRuntime, installChatBridge, threadProps } from './threadHarness';

const ipcCalls = await vi.hoisted(() => import('./ipcCalls'));
ipcCalls.settleBeforeWaits();

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));
vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { WorkbenchThread } from '../WorkbenchThread';
import type { WritingCheckRequest } from '../WritingCheckPane';

let bridge: FakeBridge;
let chat: FakeHermesChat;

type Request = Omit<WritingCheckRequest, 'seq'>;

/** The first text node under `root` that contains `text`. */
function textNode(root: Element, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(text)) return node as Text;
  }
  throw new Error(`no text node with ${text}`);
}

/**
 * Selects from `from` to the end of `to`: within one text node when `to` follows `from`
 * there, else into the last message that contains `to`.
 */
async function select(from: string, to: string) {
  const start = textNode(document.body, from);
  const startText = start.textContent ?? '';
  const sameNode = startText.indexOf(to, startText.indexOf(from)) !== -1;
  const endRoot = [...document.querySelectorAll('.wb-msg')]
    .reverse()
    .find((el) => el.textContent?.includes(to)) as Element;
  const end = sameNode ? start : textNode(endRoot, to);
  const range = document.createRange();
  range.setStart(start, start.textContent!.indexOf(from));
  range.setEnd(end, end.textContent!.indexOf(to) + to.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => document.dispatchEvent(new Event('selectionchange')));
}

async function renderChat(onCheckReply?: (request: Request) => void) {
  render(
    <HostedChatRuntime sessionId="s1">
      <WorkbenchThread {...threadProps({ sessionId: 's1', onCheckReply })} />
    </HostedChatRuntime>
  );
  await ipcCalls.settle();
}

const popoverButtons = () =>
  [...document.querySelectorAll('.wb-sel-pop button')].map((b) => b.textContent);

describe('Check writing on a selection', () => {
  beforeEach(() => {
    ({ bridge, chat } = installChatBridge('s1'));
    chat.history = [
      { role: 'user', content: 'Delve into the plan for me, please.', rowId: 1 },
      { role: 'assistant', content: 'Great question! The plan is pivotal. I hope this helps!', rowId: 2 },
    ];
    Range.prototype.getBoundingClientRect = () => new DOMRect(10, 20, 30, 10);
  });
  afterEach(async () => {
    window.getSelection()?.removeAllRanges();
    await ipcCalls.settle();
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  it('checks only the selected part of a reply', async () => {
    const onCheckReply = vi.fn<(request: Request) => void>();
    await renderChat(onCheckReply);
    await select('The plan', 'pivotal.');
    expect(popoverButtons()).toEqual(['Quote', 'Copy', 'Check']);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check' })));

    const request = onCheckReply.mock.calls[0][0];
    expect(request.markdown).toBe('The plan is pivotal.');
    expect(request.source).toBe('Selection from a reply');
    const row = document.querySelector(`.wb-msg[data-message-id="${request.messageId}"]`);
    expect(row?.classList.contains('is-assistant')).toBe(true);
    expect(window.getSelection()?.isCollapsed).toBe(true);
  });

  it('checks a selection in your own message, without Quote', async () => {
    const onCheckReply = vi.fn<(request: Request) => void>();
    await renderChat(onCheckReply);
    await select('Delve', 'plan');
    expect(popoverButtons()).toEqual(['Copy', 'Check']);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check' })));

    const request = onCheckReply.mock.calls[0][0];
    expect(request.markdown).toBe('Delve into the plan');
    expect(request.source).toBe('Selection from your message');
    const row = document.querySelector(`.wb-msg[data-message-id="${request.messageId}"]`);
    expect(row?.classList.contains('is-user')).toBe(true);
  });

  it('checks a selection across two messages as one passage', async () => {
    const onCheckReply = vi.fn<(request: Request) => void>();
    await renderChat(onCheckReply);
    await select('please.', 'Great question!');
    expect(popoverButtons()).toEqual(['Copy', 'Check']);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check' })));

    const request = onCheckReply.mock.calls[0][0];
    expect(request.markdown).toBe('please.\n\nGreat question!');
    expect(request.source).toBe('Selection across 2 messages');
  });

  it('keeps the old popover where no Check can show', async () => {
    await renderChat();
    await select('The plan', 'pivotal.');
    expect(popoverButtons()).toEqual(['Quote', 'Copy']);
    await select('Delve', 'plan');
    expect(popoverButtons()).toEqual([]);
  });
});
