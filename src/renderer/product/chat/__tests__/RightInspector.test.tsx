import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { RightInspector } from '../RightInspector';
import type { AgentProfile } from '../../../../shared/types/hermesChat';

const getAgentSoul = vi.fn();

stubElectronAPI({
  agents: {
    getSoul: (...args: unknown[]) => getAgentSoul(...args),
    revealSoul: vi.fn(),
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

describe('RightInspector', () => {
  it('shows Role and a Soul excerpt on a named DM', async () => {
    getAgentSoul.mockResolvedValue({
      success: true,
      excerpt: 'Prefers concise visual critique.',
      canOpen: true,
    });

    render(
      <RightInspector
        centerMode="conversation"
        kind="dm"
        activeChannel={null}
        activeAgent={designer}
        agents={[designer]}
        threadId="t-dm"
        projectTab={{
          project: null,
          inspect: null,
          connecting: false,
          rpcAvailable: true,
          onChangeFolder: () => undefined,
          onChooseFolder: () => undefined,
          onRevealHub: () => undefined,
          onRevealSource: () => undefined,
          onRefreshIndex: () => undefined,
          onAddFolder: () => undefined,
          onRemoveSource: () => undefined,
        }}
        onMakeChannel={() => undefined}
        onAddToChannel={() => undefined}
      />
    );

    expect(screen.getByRole('button', { name: 'Agent' })).toBeTruthy();
    expect(screen.getByText('Own UX and visual design.')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('Prefers concise visual critique.')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Open SOUL.md' })).toBeTruthy();
  });
});
