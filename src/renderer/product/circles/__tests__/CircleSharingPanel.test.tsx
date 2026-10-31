import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CircleSharing, CirclesState } from '../../../../shared/types/circles';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { useAppCommand } from '../../useAppShortcuts';
import { CircleSharingLine } from '../CircleSharingPanel';

// The controls are tested mounted, in CirclesScreen.test.tsx.

const getStatus = vi.fn();
stubElectronAPI({ onboarding: { getStatus: (...args: unknown[]) => getStatus(...args) } });

const A = 'a'.repeat(64);
const SHARING: CircleSharing = { models: [{ id: 'qwen3-8b', tools: true }], circles: [A], paused: false, away: false };
const NOT_SHARING: CircleSharing = { models: [], circles: [], paused: false, away: false };

function state(sharing: CircleSharing, overrides: Partial<CirclesState> = {}): CirclesState {
  return {
    status: 'running',
    displayName: 'Ada',
    providers: {},
    sharing,
    snapshot: {
      identity: 'f'.repeat(64),
      circles: [{ key: A, name: 'Workshop', myRole: 'member', members: [], invites: [], offers: [] }],
    },
    ...overrides,
  };
}

beforeEach(() => {
  getStatus.mockResolvedValue({ configured: true, slots: { local: { configured: true, modelId: 'qwen3-8b', health: 'reachable' } } });
});
afterEach(() => cleanup());

describe('CircleSharingLine', () => {
  it.each([
    ['someone in no Circle', state(NOT_SHARING, { snapshot: { identity: '', circles: [] } }), 'Not sharing. Create or join a Circle to share this model.'],
    ['someone sharing nothing', state(NOT_SHARING), 'Not sharing with your Circles.'],
    ['paused', state({ ...SHARING, paused: true }), "Paused: members can't use your models."],
    ['sharing', state(SHARING), 'Shared with Workshop.'],
    ['sharing in away mode', state({ ...SHARING, away: true }), 'Shared with Workshop, with away mode on.'],
  ])('says the state for %s', async (_name, circles, text) => {
    render(<CircleSharingLine circles={circles} />);
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('opens the Circles screen', () => {
    const commands: string[] = [];
    const Listener = () => {
      useAppCommand((command) => commands.push(command));
      return null;
    };
    render(
      <>
        <Listener />
        <CircleSharingLine circles={state(SHARING)} />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Circles' }));
    expect(commands).toEqual(['go-circles']);
  });
});
