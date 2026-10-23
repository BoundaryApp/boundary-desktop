import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';

const noop = () => undefined;
globalThis.ResizeObserver ??= class {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
} as unknown as typeof ResizeObserver;
Element.prototype.scrollTo ??= noop;

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock('../../../services/hermesChatIPCService', () => {
  const unsub = () => () => undefined;
  return {
    hermesChatIPC: {
      onChatPhase: unsub,
      onChatTool: unsub,
      onChatApproval: unsub,
      onChatCredentialRequest: unsub,
      listPendingCredentialRequests: async () => [],
      onChatTurnStats: unsub,
      onChatSpeaker: unsub,
      getContextBreakdown: async () => ({ success: true, breakdown: { categories: [] } }),
      completePath: vi.fn().mockResolvedValue({ success: true, items: [] }),
    },
  };
});

vi.mock('../../../services/onboardingIPCService', () => ({
  onboardingIPC: {
    getStatus: vi.fn().mockResolvedValue({ configured: true, slots: {} }),
    probeSlotHealth: vi.fn().mockResolvedValue({ health: 'reachable' }),
  },
}));

vi.mock('../InferenceChip', () => ({ InferenceChip: () => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: () => null }));

import { WorkbenchThread } from '../WorkbenchThread';
import type { AgentProfile, ChannelRecord, HermesConversationKind } from '../../../../shared/types/hermesChat';

const hermes: AgentProfile = {
  slug: 'assistant',
  displayName: 'Hermes',
  handle: 'Hermes',
  role: 'Default agent on this machine.',
  builtIn: true,
  createdAt: '1970-01-01T00:00:00.000Z',
};
const ana: AgentProfile = {
  slug: 'ana',
  displayName: 'Ana',
  handle: 'Ana',
  role: 'Researcher',
  builtIn: false,
  createdAt: '2026-09-22T00:00:00.000Z',
};
const room: ChannelRecord = {
  id: 'ch1',
  slug: 'research',
  title: 'research',
  sessionId: 's-room',
  memberSlugs: [],
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
};

const adapter = {
  async *run() {
    yield { content: [{ type: 'text' as const, text: 'ok' }] };
  },
};

const Head: React.FC<{
  kind: HermesConversationKind;
  title: string;
  agent: AgentProfile | null;
  handlers: Record<string, () => void>;
}> = ({ kind, title, agent, handlers }) => {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkbenchThread
        sessionId="s1"
        threadTitle={title}
        agent={agent}
        kind={kind === 'channel' ? null : kind}
        isChannel={kind === 'channel'}
        channel={kind === 'channel' ? room : null}
        agents={[hermes, ana]}
        activeProject={null}
        projects={[]}
        activeProjectId={null}
        toolsEnabled
        onToolsEnabledChange={() => undefined}
        onSelectProject={() => undefined}
        onClearProject={() => undefined}
        onNewProject={() => undefined}
        onCreateAgentFromDraft={() => undefined}
        onEditAgentDraft={() => undefined}
        onNewChat={handlers.newChat}
        onMakeChannel={handlers.makeChannel}
        onOpenAgentDm={handlers.openDm}
        onAddAgentToChannel={handlers.addToChannel}
      />
    </AssistantRuntimeProvider>
  );
};

const handlers = () => ({
  newChat: vi.fn(),
  makeChannel: vi.fn(),
  openDm: vi.fn(),
  addToChannel: vi.fn(),
});

describe('thread header names the kind (ADR 0023)', () => {
  afterEach(() => cleanup());

  it('Hermes chat: title, kind line, New chat and Make channel', () => {
    const h = handlers();
    render(<Head kind="hermes" title="Plan the launch" agent={hermes} handlers={h} />);
    expect(screen.getByText('Plan the launch')).toBeTruthy();
    expect(screen.getByText('Hermes chat')).toBeTruthy();
    expect(document.querySelector('.wb-thread-head .wb-kind-mark.is-hermes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make channel' }));
    expect(h.newChat).toHaveBeenCalled();
    expect(h.makeChannel).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Add to channel' })).toBeNull();
    expect(screen.getByPlaceholderText('Ask Hermes anything')).toBeTruthy();
  });

  it('DM: agent name, one ongoing thread, Add to channel only', () => {
    const h = handlers();
    render(<Head kind="dm" title="Ana" agent={ana} handlers={h} />);
    expect(screen.getByText('Direct message · one ongoing thread')).toBeTruthy();
    expect(document.querySelector('.wb-thread-head .wb-kind-mark.is-dm')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make channel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add to channel' }));
    expect(h.addToChannel).toHaveBeenCalled();
  });

  it('Side chat: its own kind line and Open DM with the agent', () => {
    const h = handlers();
    render(<Head kind="side" title="Pricing · branch" agent={ana} handlers={h} />);
    expect(screen.getByText('Side chat with Ana')).toBeTruthy();
    expect(document.querySelector('.wb-thread-head .wb-kind-mark.is-side')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open DM with Ana' }));
    expect(h.openDm).toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Message Ana · side chat')).toBeTruthy();
  });

  it('Channel: #slug and the room rule', () => {
    render(<Head kind="channel" title="#research" agent={null} handlers={handlers()} />);
    expect(screen.getByText('#research')).toBeTruthy();
    expect(screen.getByText('Channel · posts are for the room, @ asks someone now')).toBeTruthy();
    expect(document.querySelector('.wb-thread-head .wb-kind-mark.is-channel')).toBeTruthy();
  });
});

const RoomLog: React.FC<{ focusText?: string; initialQuote?: string }> = ({
  focusText,
  initialQuote,
}) => {
  const runtime = useLocalRuntime(adapter, {
    initialMessages: [
      { role: 'user', content: '@Ana which vendors publish pricing?' },
      { role: 'assistant', content: 'Two of them.', metadata: { custom: { agentSlug: 'ana' } } },
      { role: 'assistant', content: 'Confirmed.', metadata: { custom: { agentSlug: 'assistant' } } },
    ],
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkbenchThread
        sessionId="s-room"
        threadTitle="#research"
        agent={null}
        isChannel
        channel={{ ...room, memberSlugs: ['assistant', 'ana'] }}
        agents={[hermes, ana]}
        activeProject={null}
        projects={[]}
        activeProjectId={null}
        toolsEnabled
        onToolsEnabledChange={() => undefined}
        onSelectProject={() => undefined}
        onClearProject={() => undefined}
        onNewProject={() => undefined}
        onCreateAgentFromDraft={() => undefined}
        onEditAgentDraft={() => undefined}
        focusText={focusText}
        initialQuote={initialQuote}
      />
    </AssistantRuntimeProvider>
  );
};

const LiveWake: React.FC = () => {
  const runtime = useLocalRuntime(adapter, {
    initialMessages: [
      { role: 'user', content: '@Ana check pricing' },
      {
        role: 'assistant',
        content: 'Two vendors.\n\nConfirmed.',
        metadata: {
          custom: {
            agentSlug: 'ana',
            segments: [
              { agentSlug: 'ana', text: 'Two vendors.' },
              { agentSlug: 'assistant', text: 'Confirmed.' },
            ],
          },
        },
      },
    ],
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkbenchThread
        sessionId="s-room"
        threadTitle="#research"
        agent={null}
        isChannel
        channel={{ ...room, memberSlugs: ['assistant', 'ana'] }}
        agents={[hermes, ana]}
        activeProject={null}
        projects={[]}
        activeProjectId={null}
        toolsEnabled
        onToolsEnabledChange={() => undefined}
        onSelectProject={() => undefined}
        onClearProject={() => undefined}
        onNewProject={() => undefined}
        onCreateAgentFromDraft={() => undefined}
        onEditAgentDraft={() => undefined}
      />
    </AssistantRuntimeProvider>
  );
};

describe('rooms name each reply’s own speaker (ADR 0023 §9)', () => {
  afterEach(() => cleanup());

  it('labels replies by who spoke, with their mark', () => {
    render(<RoomLog />);
    const who = [...document.querySelectorAll('.wb-msg.is-assistant .wb-who')];
    expect(who.map((el) => el.textContent)).toEqual(['Ana', 'Hermes']);
    expect(who[0].querySelector('.wb-kind-mark.is-dm')).toBeTruthy();
    expect(who[1].querySelector('.wb-kind-mark.is-hermes')).toBeTruthy();
  });

  it('names each speaker in a live wake that has not reloaded yet (ADR 0010 §1)', () => {
    render(<LiveWake />);
    expect(document.querySelectorAll('.wb-msg.is-assistant')).toHaveLength(1);
    const who = [...document.querySelectorAll('.wb-msg.is-assistant .wb-who')];
    expect(who.map((el) => el.textContent)).toEqual(['Ana', 'Hermes']);
    expect(who[1].querySelector('.wb-kind-mark.is-hermes')).toBeTruthy();
    expect(screen.getByText('Two vendors.')).toBeTruthy();
    expect(screen.getByText('Confirmed.')).toBeTruthy();
  });

  it('describes Hermes as the default agent in the room @ menu', async () => {
    render(<RoomLog />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@' } });
    const menu = await screen.findByRole('listbox', { name: 'Mention' });
    expect(within(menu).getByText('Default agent · member · address now')).toBeTruthy();
    expect(within(menu).getByText('Member · address now')).toBeTruthy();
  });
});

const RoomWithoutAna: React.FC<{ onAddChannelMember: (slug: string) => Promise<boolean> }> = ({
  onAddChannelMember,
}) => {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkbenchThread
        sessionId="s-room"
        threadTitle="#research"
        agent={null}
        isChannel
        channel={{ ...room, memberSlugs: ['assistant'] }}
        agents={[hermes, ana]}
        activeProject={null}
        projects={[]}
        activeProjectId={null}
        toolsEnabled
        onToolsEnabledChange={() => undefined}
        onSelectProject={() => undefined}
        onClearProject={() => undefined}
        onNewProject={() => undefined}
        onCreateAgentFromDraft={() => undefined}
        onEditAgentDraft={() => undefined}
        onAddChannelMember={onAddChannelMember}
      />
    </AssistantRuntimeProvider>
  );
};

describe('@ someone not in the room adds them (ADR 0010 §5)', () => {
  afterEach(() => cleanup());

  async function chooseAna() {
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'ask @' } });
    const menu = await screen.findByRole('listbox', { name: 'Mention' });
    const row = within(menu).getByRole('option', { name: /Ana.*Not in channel/ });
    await act(async () => {
      fireEvent.mouseDown(row);
    });
    return box;
  }

  it('adds them, then inserts the mention', async () => {
    const add = vi.fn(async () => true);
    render(<RoomWithoutAna onAddChannelMember={add} />);
    const box = await chooseAna();
    expect(add).toHaveBeenCalledWith('ana');
    expect(box.value).toBe('ask @Ana ');
  });

  it('inserts nothing when the add fails', async () => {
    render(<RoomWithoutAna onAddChannelMember={async () => false} />);
    const box = await chooseAna();
    expect(box.value).toBe('ask @');
  });
});

describe('Mentions hand-offs into a conversation (ADR 0023 §6)', () => {
  afterEach(() => cleanup());

  it('marks the message Open in #room came for', async () => {
    render(<RoomLog focusText="which vendors publish pricing" />);
    await waitFor(() => expect(document.querySelector('.wb-msg.is-user.is-focused')).toBeTruthy());
    expect(document.querySelector('.wb-msg.is-user.is-focused')?.textContent).toContain(
      'which vendors publish pricing'
    );
  });

  it('puts a handed-over exchange in the quote chip', () => {
    render(<RoomLog initialQuote="In #research you asked: @Ana pricing?" />);
    expect(screen.getByText('In #research you asked: @Ana pricing?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove quote' })).toBeTruthy();
  });
});
