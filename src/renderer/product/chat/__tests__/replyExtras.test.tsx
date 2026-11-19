import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ElectronAPI } from '../../../../preload';
import type { FakeBridge, FakeHermesChat } from '../../../__tests__/fakeBridge';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import { HostedChatRuntime, installChatBridge, threadProps } from './threadHarness';

const ipcCalls = await vi.hoisted(() => import('./ipcCalls'));
ipcCalls.settleBeforeWaits();

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

type HermesChatAPI = ElectronAPI['hermesChat'];
// Runs stay open until a test replies to them (`reply`).
let bridge: FakeBridge;
let chat: FakeHermesChat;
let saveReply: Mock<HermesChatAPI['saveReply']>;
let revealProjectFile: Mock<HermesChatAPI['revealProjectFile']>;

function installBridge() {
  saveReply = vi.fn<HermesChatAPI['saveReply']>(async () => ({ success: true, path: '/Users/ada/Job Search/plan.md' }));
  revealProjectFile = vi.fn<HermesChatAPI['revealProjectFile']>(async () => ({ success: true }));
  ({ bridge, chat } = installChatBridge('s1', { hermesChat: { saveReply, revealProjectFile } }));
  chat.history = [
    { role: 'user', content: 'Plan my week', rowId: 1 },
    {
      role: 'assistant',
      content: '## Plan\n\n- **Mon:** write',
      rowId: 2,
      files: [
        '/opt/projects/job-search/plan.md',
        '/opt/projects/other/elsewhere.md',
        'relative.md',
      ],
    },
  ];
}

vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { WorkbenchThread } from '../WorkbenchThread';
import { setValue } from '../../../__tests__/formInput';

const project = {
  id: 'p1',
  name: 'Job Search',
  hostPath: '/Users/ada/Job Search',
  containerPath: '/opt/projects/job-search',
} as HermesProjectRecord;

const Chat: React.FC<{
  withProject?: boolean;
  onShareToCircle?: (share: { text: string; role: 'user' | 'assistant'; model?: string }) => void;
}> = ({ withProject = true, onShareToCircle }) => (
  <HostedChatRuntime sessionId="s1">
    <WorkbenchThread
      {...threadProps({
        sessionId: 's1',
        activeProject: withProject ? project : null,
        projects: withProject ? [project] : [],
        activeProjectId: withProject ? 'p1' : null,
        onShareToCircle,
      })}
    />
  </HostedChatRuntime>
);

/** Renders the chat once its history and the rest of its first loads are in. */
async function renderChat(props: React.ComponentProps<typeof Chat> = {}) {
  render(<Chat {...props} />);
  await ipcCalls.settle();
}

/** Hermes answers the open run with `text` and ends it. */
async function reply(text: string) {
  await chat.stream(text);
  await chat.finish();
}

const writeText = vi.fn(async () => undefined);
const lastSent = () => chat.startChat.mock.calls.at(-1)?.[0].messages.at(-1)?.content;

const openMenu = async () => {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'More' })));
};

describe('Reply extras', () => {
  beforeEach(() => {
    writeText.mockClear();
    installBridge();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  it('shares a reply or a prompt to a Circle from More, and offers nothing extra on prompts', async () => {
    const share = vi.fn();
    await renderChat({ onShareToCircle: share });
    const [promptMore, replyMore] = screen.getAllByRole('button', { name: 'More' });
    await act(async () => fireEvent.click(promptMore));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Share to Circle…everyone in the Circle gets a copy',
    ]);
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /Share to Circle/ })));
    expect(share).toHaveBeenLastCalledWith({ text: expect.any(String), role: 'user' });
    await act(async () => fireEvent.click(replyMore));
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /Share to Circle/ })));
    expect(share).toHaveBeenLastCalledWith(expect.objectContaining({ text: '## Plan\n\n- **Mon:** write', role: 'assistant' }));
  });

  it('offers no Share outside Circles, and no More on prompts', async () => {
    await renderChat();
    expect(screen.getAllByRole('button', { name: 'More' })).toHaveLength(1);
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /Share to Circle/ })).toBeNull();
  });

  it('copies a reply as plain text', async () => {
    await renderChat();
    await openMenu();
    await act(async () =>
      fireEvent.click(screen.getByRole('menuitem', { name: /Copy as plain text/ }))
    );
    expect(writeText).toHaveBeenCalledWith('Plan\n\n• Mon: write');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('quotes a reply above what you type, and the quote can be removed', async () => {
    await renderChat();
    await openMenu();
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /Quote in reply/ })));
    expect(document.querySelector('.wb-quote p')?.textContent).toBe('## Plan\n\n- **Mon:** write');

    // Removing it means nothing is quoted.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove quote' })));
    expect(document.querySelector('.wb-quote')).toBeNull();

    await openMenu();
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /Quote in reply/ })));
    const input = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;
    await act(async () => setValue(input, 'Make Monday lighter.'));
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    await ipcCalls.settle();
    expect(lastSent()).toBe('> ## Plan\n>\n> - **Mon:** write\n\nMake Monday lighter.');
    expect(document.querySelector('.wb-quote')).toBeNull();
    await reply('noted');
    expect(screen.getByText('noted')).toBeTruthy();

    // The sent prompt shows the quote as a block above what was typed.
    const bubbles = document.querySelectorAll('.wb-msg.is-user .wb-bubble');
    const sent = bubbles[bubbles.length - 1];
    expect(sent.querySelector('.wb-user-quote')?.textContent).toBe('## Plan\n\n- **Mon:** write');
    expect(sent.querySelector('p')?.textContent).toBe('Make Monday lighter.');
  });

  it('saves a reply to the project and says where', async () => {
    await renderChat();
    await openMenu();
    await act(async () =>
      fireEvent.click(screen.getByRole('menuitem', { name: /Save to Job Search/ }))
    );
    expect(saveReply).toHaveBeenCalledWith({
      projectId: 'p1',
      content: '## Plan\n\n- **Mon:** write',
    });
    await ipcCalls.settle();
    expect(screen.getByText('Saved plan.md')).toBeTruthy();
  });

  it('offers no Save without a project', async () => {
    await renderChat({ withProject: false });
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /Save to/ })).toBeNull();
  });

  it('reveals only tool paths inside the project (while the turn is live)', async () => {
    await renderChat();
    // Tool cards are progress (ADR 0006): they show while a turn is running.
    await bridge.emit('hermes-chat:phase', { requestId: 'r1', sessionId: 's1', phase: 'tool' });
    await bridge.emit('hermes-chat:tool', {
      requestId: 'r1',
      toolId: 't1',
      name: 'write_file',
      status: 'done',
      paths: ['/opt/projects/job-search/letters/acme.md', 'notes.md'],
    });
    const card = await waitFor(() => {
      const el = document.querySelector('.wb-tool');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const reveal = within(card).getAllByRole('button', { name: 'Reveal' });
    expect(reveal).toHaveLength(1);
    await act(async () => fireEvent.click(reveal[0]));
    expect(revealProjectFile).toHaveBeenCalledWith({
      projectId: 'p1',
      relativePath: 'letters/acme.md',
    });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Copy path' })));
    expect(writeText).toHaveBeenCalledWith('/Users/ada/Job Search/letters/acme.md');
  });

  it('lists the files a finished reply wrote inside the project', async () => {
    await renderChat();
    const files = document.querySelector('.wb-files') as HTMLElement;
    expect(files).not.toBeNull();
    expect([...files.querySelectorAll('.wb-file .mono')].map((f) => f.textContent)).toEqual([
      'plan.md',
    ]);
    await act(async () => fireEvent.click(within(files).getByRole('button', { name: 'Reveal' })));
    expect(revealProjectFile).toHaveBeenCalledWith({ projectId: 'p1', relativePath: 'plan.md' });
  });

  it('shows no Files line without a project', async () => {
    await renderChat({ withProject: false });
    expect(document.querySelector('.wb-files')).toBeNull();
  });
});
