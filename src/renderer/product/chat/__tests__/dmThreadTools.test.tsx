import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';

const scrolled: Element[] = [];
Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
  scrolled.push(this);
};

const { getContextBreakdown } = vi.hoisted(() => ({
  getContextBreakdown: vi.fn(async (..._args: unknown[]) => ({
    success: true,
    breakdown: { categories: [] } as Record<string, unknown>,
  })),
}));

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

stubElectronAPI({
  hermesChat: {
    listPendingCredentialRequests: async (): Promise<HermesChatCredentialRequestEvent[]> => [],
    getContextBreakdown: (...args: unknown[]) => getContextBreakdown(...args),
  },
  onboarding: {
    getStatus: vi.fn().mockResolvedValue({ configured: true, slots: {} }),
    probeSlotHealth: vi.fn().mockResolvedValue({ health: 'reachable' }),
  },
  projects: {
    completePath: vi.fn().mockResolvedValue({ success: true, items: [] }),
  },
});

vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { WorkbenchThread } from '../WorkbenchThread';
import type {
  AgentProfile,
  HermesChatCredentialRequestEvent,
} from '../../../../shared/types/hermesChat';
import { flushMenu, openMenu } from '../../../__tests__/openMenu';
import { localDayKey } from '../../../../shared/messageTime';

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

const adapter = {
  async *run() {
    yield { content: [{ type: 'text' as const, text: 'ok' }] };
  },
};

const ts = (iso: string, rowId?: number) => ({
  custom: { ts: Date.parse(iso) / 1000, ...(rowId != null ? { rowId } : {}) },
});

const Dm: React.FC<{ channel?: boolean }> = ({ channel = false }) => {
  const runtime = useLocalRuntime(adapter, {
    initialMessages: [
      { role: 'user', content: 'Keep a list of pricing sources.', metadata: ts('2026-09-22T09:00:00', 1) },
      { role: 'assistant', content: 'Started one: vendor pricing first.', metadata: ts('2026-09-22T09:01:00', 2) },
      { role: 'user', content: 'Any new pricing pages?', metadata: ts('2026-09-29T10:00:00', 3) },
      { role: 'assistant', content: 'Two more.', metadata: ts('2026-09-29T10:01:00', 4) },
    ],
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkbenchThread
        sessionId="s-dm"
        threadTitle="Ana"
        agent={channel ? null : ana}
        kind={channel ? 'channel' : 'dm'}
        channel={
          channel
            ? {
                id: 'ch1',
                slug: 'research',
                title: 'research',
                sessionId: 's-dm',
                memberSlugs: ['ana'],
                createdAt: '2026-09-22T00:00:00.000Z',
                updatedAt: '2026-09-22T00:00:00.000Z',
              }
            : null
        }
        agents={[hermes, ana]}
        startedAt="2026-09-22T09:00:00"
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

const pressCmdF = async () => {
  await act(async () => {
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  });
};

describe('DM long-thread tools (chat types Phase 7a)', () => {
  afterEach(() => {
    cleanup();
    scrolled.length = 0;
    getContextBreakdown.mockClear();
  });

  it('shows Ongoing since and jumps to a day divider', async () => {
    render(<Dm />);
    await screen.findByText('Two more.');
    expect(screen.getByText(/Ongoing since/)).toBeTruthy();
    const trigger = screen.getByRole('button', { name: 'Jump to date' });
    openMenu(trigger);
    const menu = screen.getByRole('menu', { name: 'Jump to date' });
    const days = within(menu).getAllByRole('menuitem');
    expect(days).toHaveLength(2);
    fireEvent.click(days[0]);
    const key = localDayKey(Date.parse('2026-09-22T09:00:00'));
    expect(scrolled.some((el) => el.getAttribute('data-day') === key)).toBe(true);
    expect(screen.queryByRole('menu', { name: 'Jump to date' })).toBeNull();
    await flushMenu();
    expect(document.activeElement).toBe(trigger);
  });

  it('Search this DM counts matches and steps through them, newest first', async () => {
    render(<Dm />);
    await screen.findByText('Two more.');
    fireEvent.click(screen.getByRole('button', { name: 'Search this DM' }));
    const field = screen.getByRole('searchbox', { name: 'Search this DM' });
    fireEvent.change(field, { target: { value: 'pricing' } });
    expect(screen.getByText('3 of 3')).toBeTruthy();
    expect(document.querySelector('.wb-msg.is-find-current')?.textContent).toContain(
      'Any new pricing pages?'
    );
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText('1 of 3')).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(screen.getByText('3 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(screen.getByText('2 of 3')).toBeTruthy();
    fireEvent.change(field, { target: { value: 'nothing like this' } });
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('⌘F opens search in a DM, and Esc closes it and focuses the composer', async () => {
    render(<Dm />);
    await screen.findByText('Two more.');
    await pressCmdF();
    const field = screen.getByRole('searchbox', { name: 'Search this DM' });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('searchbox', { name: 'Search this DM' })).toBeNull();
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    expect(document.querySelector('.wb-msg.is-find-current')).toBeNull();
  });

  it('channels get neither the log head nor ⌘F', async () => {
    render(<Dm channel />);
    await screen.findByText('Two more.');
    expect(screen.queryByText(/Ongoing since/)).toBeNull();
    await pressCmdF();
    expect(screen.queryByRole('searchbox', { name: 'Search this DM' })).toBeNull();
  });

  it('draws the horizon at the reported row, dims above it, and shows the chip (7b)', async () => {
    getContextBreakdown.mockResolvedValueOnce({
      success: true,
      breakdown: {
        categories: [],
        history: { budget: 8000, tokens: 6100, firstRowId: 3, summarised: false },
      },
    });
    render(<Dm />);
    await screen.findByText('Two more.');
    const line = await screen.findByRole('separator', {
      name: 'Ana’s next reply sees from here down · about 6.1K of 8K tokens',
    });
    expect(line.closest('.wb-msg')?.textContent).toContain('Any new pricing pages?');
    const dimmed = [...document.querySelectorAll('.wb-msg.is-beyond-horizon')];
    expect(dimmed).toHaveLength(2);
    expect(dimmed[0].textContent).toContain('Keep a list of pricing sources.');
    expect(screen.getByText('Context: recent · 8K')).toBeTruthy();
    expect(getContextBreakdown).toHaveBeenCalledWith({ sessionId: 's-dm' });
  });

  it('says so when the earlier part is summarised (7b)', async () => {
    getContextBreakdown.mockResolvedValueOnce({
      success: true,
      breakdown: {
        categories: [],
        history: { budget: 8000, tokens: 7900, firstRowId: 3, summarised: true },
      },
    });
    render(<Dm />);
    expect(
      await screen.findByRole('separator', {
        name: 'Earlier messages are summarised for Ana · about 7.9K of 8K tokens',
      })
    ).toBeTruthy();
  });

  it('draws nothing and hides the chip without a reported cut (7b.2)', async () => {
    render(<Dm />);
    await screen.findByText('Two more.');
    await act(async () => undefined);
    expect(getContextBreakdown).toHaveBeenCalled();
    expect(document.querySelector('.wb-horizon')).toBeNull();
    expect(document.querySelector('.wb-msg.is-beyond-horizon')).toBeNull();
    expect(screen.queryByText(/Context: recent/)).toBeNull();
  });

  it('a budget whose cut keeps the whole thread draws no line but shows the chip', async () => {
    getContextBreakdown.mockResolvedValueOnce({
      success: true,
      breakdown: {
        categories: [],
        history: { budget: 8000, tokens: 900, firstRowId: 1, summarised: false },
      },
    });
    render(<Dm />);
    expect(await screen.findByText('Context: recent · 8K')).toBeTruthy();
    expect(document.querySelector('.wb-horizon')).toBeNull();
  });

  it('channels never ask for the cut', async () => {
    render(<Dm channel />);
    await screen.findByText('Two more.');
    await act(async () => undefined);
    expect(getContextBreakdown).not.toHaveBeenCalled();
  });
});
