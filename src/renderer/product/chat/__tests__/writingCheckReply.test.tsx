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

const REPLY = 'Great question! We delve into it.\n\n```\ndelve()\n```';

describe('Check writing on a reply', () => {
  beforeEach(() => {
    ({ bridge, chat } = installChatBridge('s1'));
    chat.history = [
      { role: 'user', content: 'Plan my week', rowId: 1 },
      { role: 'assistant', content: REPLY, rowId: 2, timestamp: 1_762_860_000 },
    ];
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  it('sends the reply’s markdown and its message to the inspector, from replies only', async () => {
    const onCheckReply = vi.fn<(request: Omit<WritingCheckRequest, 'seq'>) => void>();
    render(
      <HostedChatRuntime sessionId="s1">
        <WorkbenchThread {...threadProps({ sessionId: 's1', onCheckReply })} />
      </HostedChatRuntime>
    );
    await ipcCalls.settle();

    const buttons = screen.getAllByRole('button', { name: 'Check writing' });
    expect(buttons).toHaveLength(1);
    await act(async () => fireEvent.click(buttons[0]));

    const request = onCheckReply.mock.calls[0][0];
    expect(request.markdown).toBe(REPLY);
    expect(request.source).toMatch(/^Reply · /);
    const row = document.querySelector(`.wb-msg[data-message-id="${request.messageId}"]`);
    expect(row?.classList.contains('is-assistant')).toBe(true);
  });

  it('offers no Check without a place to show it', async () => {
    render(
      <HostedChatRuntime sessionId="s1">
        <WorkbenchThread {...threadProps({ sessionId: 's1' })} />
      </HostedChatRuntime>
    );
    await ipcCalls.settle();
    expect(screen.queryByRole('button', { name: 'Check writing' })).toBeNull();
  });
});
