import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localDay } from '../../../../shared/circleUsage';
import type { CircleSharing, CirclesState } from '../../../../shared/types/circles';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { MemberLimit, SharingUsage, YourUsage } from '../CircleUsage';

const A = 'a'.repeat(64);
const BO = 'b'.repeat(64);
const SHARING: CircleSharing = { models: [{ id: 'qwen3-8b', tools: true }], circles: [A], paused: false, away: false };

function state(overrides: Partial<CirclesState> = {}): CirclesState {
  return {
    status: 'running',
    displayName: 'Ada',
    providers: {},
    sharing: SHARING,
    snapshot: {
      identity: 'f'.repeat(64),
      circles: [
        {
          key: A,
          name: 'Workshop',
          myRole: 'admin',
          writable: true,
          members: [{ identity: BO, name: 'Bo', role: 'member', isMe: false, online: true }],
          invites: [],
          offers: [],
        },
      ],
    },
    ...overrides,
  };
}

const today = localDay(new Date());

afterEach(() => cleanup());

describe('SharingUsage', () => {
  it('shows each member’s day, who is running, and their limit', () => {
    render(
      <SharingUsage
        circles={state({
          served: { day: today, counts: { [BO]: { requests: 42, tokens: 186_000 } } },
          serving: { running: BO, queued: [] },
          sharing: { ...SHARING, limits: { everyone: { tokensPerDay: 100_000 }, members: {} } },
        })}
      />
    );
    const row = screen.getByRole('row', { name: /Bo/ });
    expect(within(row).getByText('Running')).toBeTruthy();
    expect(within(row).getByText('42')).toBeTruthy();
    expect(within(row).getByText('186K')).toBeTruthy();
    expect(within(row).getByText('100K tokens')).toBeTruthy();
  });

  it('doesn’t show yesterday’s counts', () => {
    render(<SharingUsage circles={state({ served: { day: '2000-01-01', counts: { [BO]: { requests: 3, tokens: 0 } } } })} />);
    expect(screen.getByText('No member has used your models today.')).toBeTruthy();
  });

  it('saves the limit for everyone, and an emptied field means no limit', async () => {
    const setSharing = vi.fn().mockResolvedValue({ success: true, state: state() });
    stubElectronAPI({ circles: { setSharing } });
    render(<SharingUsage circles={state({ sharing: { ...SHARING, limits: { everyone: { concurrent: 2 }, members: { [BO]: {} } } } })} />);
    fireEvent.change(screen.getByLabelText('Requests a day for everyone'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('At once for everyone'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await vi.waitFor(() => expect(setSharing).toHaveBeenCalled());
    expect(setSharing.mock.calls[0][0].limits).toEqual({ everyone: { requestsPerDay: 20 }, members: { [BO]: {} } });
  });
});

describe('MemberLimit', () => {
  it('starts from the limit for everyone, and can go back to it', async () => {
    const setSharing = vi.fn().mockResolvedValue({ success: true, state: state() });
    stubElectronAPI({ circles: { setSharing } });
    const limits = { everyone: { requestsPerDay: 5 }, members: {} };
    const { rerender } = render(<MemberLimit identity={BO} name="Bo" circles={state({ sharing: { ...SHARING, limits } })} />);
    expect((screen.getByLabelText('Requests a day for Bo') as HTMLInputElement).value).toBe('5');
    expect(screen.queryByRole('button', { name: 'Use the limit for everyone' })).toBeNull();

    const own = { ...limits, members: { [BO]: { requestsPerDay: 50 } } };
    rerender(<MemberLimit identity={BO} name="Bo" circles={state({ sharing: { ...SHARING, limits: own } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use the limit for everyone' }));
    await vi.waitFor(() => expect(setSharing).toHaveBeenCalled());
    expect(setSharing.mock.calls[0][0].limits.members).toEqual({});
  });
});

describe('YourUsage', () => {
  it('says what the user used of a provider today, and nothing before that', () => {
    const { container, rerender } = render(<YourUsage identity={BO} circles={state()} />);
    expect(container.textContent).toBe('');
    rerender(<YourUsage identity={BO} circles={state({ used: { day: today, counts: { [BO]: { requests: 1, tokens: 900 } } } })} />);
    expect(screen.getByText('You used 1 request and 900 tokens today.')).toBeTruthy();
  });
});
