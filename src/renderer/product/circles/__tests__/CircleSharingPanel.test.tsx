import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CircleSharing, CirclesState } from '../../../../shared/types/circles';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { CircleSharingPanel } from '../CircleSharingPanel';

const setSharing = vi.fn();
stubElectronAPI({ circles: { setSharing: (...args: unknown[]) => setSharing(...args) } });

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const NOT_SHARING: CircleSharing = { models: [], circles: [], paused: false, away: false };

function state(sharing: CircleSharing = NOT_SHARING, overrides: Partial<CirclesState> = {}): CirclesState {
  const circle = (key: string, name: string) => ({ key, name, myRole: 'member' as const, members: [], invites: [], offers: [] });
  return {
    status: 'running',
    displayName: 'Ada',
    providers: {},
    sharing,
    snapshot: { identity: 'f'.repeat(64), circles: [circle(A, 'Workshop'), circle(B, 'Family')] },
    ...overrides,
  };
}

const models = [{ id: 'qwen3-8b', contextLength: 32768 }, { id: 'gemma' }];

beforeEach(() => {
  setSharing.mockReset();
  setSharing.mockImplementation(async (sharing: CircleSharing) => ({ success: true, state: state(sharing) }));
});
afterEach(() => cleanup());

describe('CircleSharingPanel', () => {
  it('shows nothing for someone in no Circle', () => {
    render(<CircleSharingPanel circles={{ ...state(), snapshot: { identity: '', circles: [] } }} models={models} />);
    expect(screen.queryByRole('group', { name: 'Share with your Circles' })).toBeNull();
  });

  it('adds a model with its context, and a Circle, each saved at once', () => {
    const { rerender } = render(<CircleSharingPanel circles={state()} models={models} />);
    const panel = screen.getByRole('group', { name: 'Share with your Circles' });
    expect(within(panel).getByText('Not sharing.')).toBeTruthy();
    expect(within(panel).queryByRole('switch', { name: 'Away mode' })).toBeNull();
    expect(within(panel).getByText('32K context')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('checkbox', { name: /qwen3-8b/ }));
    expect(setSharing).toHaveBeenLastCalledWith({
      ...NOT_SHARING,
      models: [{ id: 'qwen3-8b', tools: true, contextLength: 32768 }],
    });

    const withModel = { ...NOT_SHARING, models: [{ id: 'qwen3-8b', tools: true, contextLength: 32768 }] };
    rerender(<CircleSharingPanel circles={state(withModel)} models={models} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Workshop' }));
    expect(setSharing).toHaveBeenLastCalledWith({ ...withModel, circles: [A] });
  });

  it('says who can use the models, and offers pause and away mode once sharing', async () => {
    const sharing = { models: [{ id: 'qwen3-8b', tools: true }], circles: [A], paused: false, away: false };
    render(<CircleSharingPanel circles={state(sharing)} models={models} />);
    expect(screen.getByText('Members of Workshop can use this model while Boundary is open.')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Away mode' }));
    expect(setSharing).toHaveBeenLastCalledWith({ ...sharing, away: true });
    // Controls are disabled while a save is in flight; let it settle.
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('switch', { name: 'Pause sharing' }));
    expect(setSharing).toHaveBeenLastCalledWith({ ...sharing, paused: true });
  });

  it('keeps a shared model the server no longer lists, so it can be turned off', () => {
    const sharing = { models: [{ id: 'old-model', tools: true }], circles: [A], paused: true, away: false };
    render(<CircleSharingPanel circles={state(sharing, { status: 'starting' })} models={models} />);
    expect(screen.getByText('Paused. Members see your models as unavailable.')).toBeTruthy();
    expect(screen.getByText(/Circles aren't connected/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'old-model' }));
    expect(setSharing).toHaveBeenLastCalledWith({ ...sharing, models: [] });
  });

  it('shows a refusal from main', async () => {
    setSharing.mockResolvedValue({ success: false, error: 'Share at most 32 models.', state: state() });
    render(<CircleSharingPanel circles={state()} models={models} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /gemma/ }));
    expect(await screen.findByText('Share at most 32 models.')).toBeTruthy();
  });
});
