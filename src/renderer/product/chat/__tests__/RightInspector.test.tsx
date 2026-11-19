import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { WritingVoiceView } from '../../../../shared/types/writingVoices';
import type { ProjectSourcesRailProps } from '../ProjectSourcesRail';
import { RightInspector } from '../RightInspector';
import type { AgentProfile } from '../../../../shared/types/hermesChat';

const getAgentSoul = vi.fn();
const setWritingVoices = vi.fn();

const plainVoice: WritingVoiceView = {
  id: 'plain',
  name: 'Plain',
  status: 'ready',
  pieces: 1,
  words: 1,
  createdAt: '',
  calibratedAt: null,
  sampleHash: '',
  style: null,
  samplesChanged: false,
  step: null,
};

stubElectronAPI({
  agents: {
    getSoul: (...args: unknown[]) => getAgentSoul(...args),
    revealSoul: vi.fn(),
    setWritingVoices: (...args: unknown[]) => setWritingVoices(...args),
  },
  writingVoices: {
    list: vi.fn().mockResolvedValue({ success: true, voices: [plainVoice] }),
    onProgress: () => (): void => undefined,
  },
});

const designer: AgentProfile = {
  slug: 'designer',
  displayName: 'UI/UX Designer',
  handle: 'designer',
  role: 'Own UX and visual design.',
  builtIn: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const projectTab: Omit<ProjectSourcesRailProps, 'role'> = {
  project: null,
  inspect: null,
  connecting: false,
  rpcAvailable: true,
  onChangeFolder: (): void => undefined,
  onChooseFolder: (): void => undefined,
  onRevealHub: (): void => undefined,
  onRevealSource: (): void => undefined,
  onRefreshIndex: (): void => undefined,
  onAddFolder: (): void => undefined,
  onRemoveSource: (): void => undefined,
};

function renderAgent(agent: AgentProfile) {
  return render(
    <RightInspector
      centerMode="conversation"
      kind="dm"
      activeChannel={null}
      activeAgent={agent}
      agents={[agent]}
      threadId="t-dm"
      projectTab={projectTab}
      onMakeChannel={() => undefined}
      onAddToChannel={() => undefined}
    />
  );
}

describe('RightInspector', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the role once, without a Soul excerpt that repeats it', async () => {
    getAgentSoul.mockResolvedValue({
      success: true,
      excerpt: 'Own UX and visual design.',
      canOpen: true,
    });

    renderAgent(designer);

    expect(screen.getByRole('button', { name: 'Agent' })).toBeTruthy();
    expect(screen.getAllByText('Own UX and visual design.')).toHaveLength(1);
    expect(screen.queryByText('Soul')).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open SOUL.md' })).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('clamps a role longer than four lines behind Show more', async () => {
    getAgentSoul.mockResolvedValue({ success: true, excerpt: null, canOpen: false });
    // The test DOM has no layout or line height, so the 20px fallback applies: report ten lines.
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);

    renderAgent({ ...designer, role: 'A long role. '.repeat(40).trim() });
    await waitFor(() => expect(getAgentSoul).toHaveBeenCalled());

    const role = screen.getByText(/^A long role\./);
    expect(role.className).toBe('is-clamped');
    const more = screen.getByRole('button', { name: 'Show more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(more);
    expect(role.className).toBe('');
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
      'true'
    );
  });

  it("shows a personality's writing voices by name", async () => {
    getAgentSoul.mockResolvedValue({ success: true, canOpen: false });
    renderAgent({ ...designer, chatRepliesVoiceId: 'plain', draftsVoiceId: null });
    expect(await screen.findByText('Plain')).toBeTruthy();
    expect(screen.getByText('Chat replies')).toBeTruthy();
    expect(screen.getByText('No voice')).toBeTruthy();
    expect(screen.queryByLabelText('Chat replies')).toBeNull();
  });

  it("sets the built-in agent's writing voices from the inspector", async () => {
    getAgentSoul.mockResolvedValue({ success: true, canOpen: false });
    setWritingVoices.mockResolvedValue({ success: true, agent: {} });
    renderAgent({ ...designer, slug: 'assistant', builtIn: true });
    await screen.findAllByRole('option', { name: 'Plain' });
    fireEvent.change(screen.getByLabelText('Drafts'), { target: { value: 'plain' } });
    await waitFor(() =>
      expect(setWritingVoices).toHaveBeenCalledWith('assistant', { chatRepliesVoiceId: null, draftsVoiceId: 'plain' })
    );
  });
});
