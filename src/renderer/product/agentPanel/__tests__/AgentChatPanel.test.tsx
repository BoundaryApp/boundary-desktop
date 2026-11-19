import React from 'react';
import { act, cleanup, configure, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  createFakeBridge,
  fakeHermesChat,
  settle,
  withIdleMain,
  type FakeBridge,
  type FakeHermesChat,
} from '../../../__tests__/fakeBridge';
import type { AgentProfile, HermesChatThreadSummary, HermesProjectRecord } from '../../../../shared/types/hermesChat';

/**
 * The desktop panel's Agent tab (ADR 0058 §7, agent window spec decisions 5 and 6): the real
 * runtime and thread under one `ChatRuntimeHost`, against a fake bridge.
 */

configure({ defaultHidden: true });

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

import { AgentChatPanel } from '../AgentChatPanel';
import { resetPanelChatForTests, setPanelChat, usePanelChat } from '../agentPanelChat';
import { ChatRuntimeHost } from '../../chat/chatRuntimeHost';
import { resetChatDraftsForTests } from '../../chat/chatDrafts';
import { setRunningTurnsForTests } from '../../chat/runningTurns';

const hob: AgentProfile = {
  slug: 'hermes',
  displayName: 'Marlow',
  handle: 'Marlow',
  role: 'Assistant',
  builtIn: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const project = (id: string, name: string): HermesProjectRecord => ({
  id,
  name,
  hostPath: `/Users/me/${id}`,
  containerPath: `/workspace/${id}`,
  slug: id,
  kind: 'host-folder',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const thread = (id: string, title: string, updatedAt: string, extra: Partial<HermesChatThreadSummary> = {}): HermesChatThreadSummary => ({
  id,
  title,
  updatedAt,
  kind: 'hermes' as const,
  agentSlug: 'hermes',
  projectId: null,
  ...extra,
});

let bridge: FakeBridge;
let chat: FakeHermesChat;
let threads: HermesChatThreadSummary[];
let createHermesChat: Mock<(payload: { projectId?: string | null }) => Promise<{ success: boolean; thread: HermesChatThreadSummary }>>;
/** Chats Hermes runs under another id than the stored one. */
let runtimeIds: Record<string, string>;
const onExpand = vi.fn();

function PanelChat() {
  return <output aria-label="panel chat">{usePanelChat() ?? 'none'}</output>;
}

async function show() {
  render(
    <ChatRuntimeHost>
      <AgentChatPanel onExpand={onExpand} />
      <PanelChat />
    </ChatRuntimeHost>
  );
  await settle();
}

const composer = () => document.querySelector('textarea:not([aria-hidden])') as HTMLTextAreaElement;
const picker = () => screen.getByRole('combobox', { name: 'Chat' }) as HTMLSelectElement;
const panelChat = () => screen.getByRole('status', { name: 'panel chat' }).textContent;

async function send(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer(), text);
    fireEvent.input(composer());
  });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send message' })));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  resetPanelChatForTests();
  resetChatDraftsForTests();
  onExpand.mockReset();
  runtimeIds = {};
  bridge = createFakeBridge();
  chat = fakeHermesChat(bridge, 's-launch');
  threads = [
    thread('s-resume', 'Resume summary', '2026-11-10T09:00:00.000Z', { projectId: null }),
    thread('s-launch', 'Plan the launch', '2026-11-12T09:00:00.000Z', { projectId: 'p1' }),
    thread('s-dm', 'Marlow', '2026-11-13T09:00:00.000Z', { kind: 'dm' }),
  ];
  createHermesChat = vi.fn(async ({ projectId }: { projectId?: string | null }) => ({
    success: true,
    thread: thread('s-new', 'New chat', '2026-11-13T10:00:00.000Z', { projectId: projectId ?? null }),
  }));
  bridge.install(
    withIdleMain(bridge, {
      hermesChat: {
        ...chat.leaves,
        // Main answers for the chat asked about.
        getHistory: async ({ sessionId }) => ({ success: true, sessionId: runtimeIds[sessionId] ?? sessionId, messages: [] }),
        listThreads: async () => ({ success: true, threads }),
        createHermesChat: (payload) => createHermesChat(payload),
        onSessionsChanged: bridge.listen('hermes-chat:sessions-changed'),
      },
      agents: {
        list: async () => ({ success: true, agents: [hob], standingDmByAgent: {} }),
        onChanged: bridge.listen('hermes-agents:changed'),
      },
      projects: {
        list: async () => ({ success: true, projects: [project('p1', 'Job Search')], activeId: 'p1' }),
      },
    })
  );
});

afterEach(async () => {
  await settle();
  cleanup();
  setRunningTurnsForTests([]);
  vi.useRealTimers();
  expect(bridge.unfaked).toEqual([]);
});

describe('AgentChatPanel (ADR 0058 §7)', () => {
  it('reads as a private chat: the line and the placeholder, and no project chip', async () => {
    await show();
    expect(screen.getByText('Only you and Marlow see this. It stays on this Mac.')).toBeTruthy();
    expect(composer().placeholder).toBe('Ask Marlow · only you see this');
    expect(screen.queryByRole('button', { name: 'Where this chat lives' })).toBeNull();
  });

  it('opens on the most recent chat with the agent the first time', async () => {
    await show();
    expect(picker().value).toBe('s-launch');
    expect(panelChat()).toBe('s-launch');
  });

  it('opens on the chat last open in the panel', async () => {
    act(() => setPanelChat('s-resume'));
    await show();
    expect(picker().value).toBe('s-resume');
  });

  it('keeps its chat when Hermes runs it under another id', async () => {
    runtimeIds = { 's-launch': 'rt-launch' };
    await show();
    expect(panelChat()).toBe('s-launch');
    expect(picker().value).toBe('s-launch');
  });

  it('lists the agent’s chats newest first with their projects, and opens the one picked', async () => {
    await show();
    const options = within(picker()).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Plan the launch · Job Search', 'Resume summary · No project']);
    await act(async () => fireEvent.change(picker(), { target: { value: 's-resume' } }));
    expect(panelChat()).toBe('s-resume');
  });

  it('starts a new chat in the same project', async () => {
    await show();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'New chat' })));
    await settle();
    expect(createHermesChat).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(panelChat()).toBe('s-new');
  });

  it('shows what Chat shows when the agent can’t answer', async () => {
    await show();
    await send('are you there?');
    await chat.fail('The assistant isn’t running.');
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('The assistant isn’t running.');
  });

  it('leaves a running reply running on Escape, so the panel can close over it', async () => {
    await show();
    await send('write a haiku');
    await chat.stream('Autumn ');
    await act(async () => fireEvent.keyDown(composer(), { key: 'Escape' }));
    await settle();
    expect(chat.cancelChat).not.toHaveBeenCalled();
    await chat.finish();
  });
});
