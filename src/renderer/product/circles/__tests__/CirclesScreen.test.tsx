import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CirclesState } from '../../../../shared/types/circles';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { CirclesScreen } from '../CirclesScreen';

const getState = vi.fn();
const setDisplayName = vi.fn();
const create = vi.fn();
const join = vi.fn();
const createInvite = vi.fn();
const removeMember = vi.fn();
const setRole = vi.fn();
const setProviderSettings = vi.fn();
const push = vi.hoisted(() => ({ current: null as ((state: unknown) => void) | null }));

stubElectronAPI({
  circles: {
    getState: (...args: unknown[]) => getState(...args),
    setDisplayName: (...args: unknown[]) => setDisplayName(...args),
    create: (...args: unknown[]) => create(...args),
    join: (...args: unknown[]) => join(...args),
    createInvite: (...args: unknown[]) => createInvite(...args),
    removeMember: (...args: unknown[]) => removeMember(...args),
    setRole: (...args: unknown[]) => setRole(...args),
    setProviderSettings: (...args: unknown[]) => setProviderSettings(...args),
    onState: (cb: (state: unknown) => void) => {
      push.current = cb;
      return () => undefined;
    },
  },
});

const unnamed: CirclesState = { status: 'stopped', displayName: '', snapshot: { identity: '', circles: [] }, providers: {} };

const withCircle = (myRole: 'admin' | 'member'): CirclesState => ({
  status: 'running',
  displayName: 'Ada',
  snapshot: {
    identity: 'a'.repeat(64),
    circles: [
      {
        key: 'c'.repeat(64),
        name: 'Garden club',
        myRole,
        members: [
          { identity: 'a'.repeat(64), name: 'Ada', role: myRole, isMe: true, online: true },
          { identity: 'b'.repeat(64), name: 'Bo', role: 'member', isMe: false, online: false },
        ],
        invites: [],
        offers: [],
      },
    ],
  },
  providers: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(unnamed);
});

afterEach(() => cleanup());

describe('CirclesScreen', () => {
  it('asks for a name before offering to create or join', async () => {
    setDisplayName.mockResolvedValue({ success: true, state: { ...unnamed, displayName: 'Ada' } });
    render(<CirclesScreen />);
    expect(await screen.findByLabelText('Your name in Circles')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'New Circle' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Your name in Circles'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(setDisplayName).toHaveBeenCalledWith({ name: 'Ada' });
    act(() => push.current?.({ ...unnamed, displayName: 'Ada' }));
    expect(await screen.findByRole('form', { name: 'New Circle' })).toBeTruthy();
  });

  it('says joining waits for an admin, and shows a refusal', async () => {
    getState.mockResolvedValue({ ...unnamed, displayName: 'Bo' });
    let answer!: (value: unknown) => void;
    join.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<CirclesScreen />);
    fireEvent.change(await screen.findByLabelText('Invite code'), { target: { value: ' code ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(join).toHaveBeenCalledWith({ code: ' code ' });
    expect(await screen.findByText(/admin of the Circle has to be online/)).toBeTruthy();
    await act(async () => answer({ success: false, error: 'That invite has expired. Ask for a new one.', state: unnamed }));
    expect(screen.getByText('That invite has expired. Ask for a new one.')).toBeTruthy();
  });

  it('lets an admin invite, change roles and remove, saying removal is forward-only', async () => {
    getState.mockResolvedValue(withCircle('admin'));
    createInvite.mockResolvedValue({ success: true, state: withCircle('admin'), invite: { id: 'f'.repeat(64), code: 'yry-code', expires: Date.now() + 7 * 86_400_000 } });
    removeMember.mockResolvedValue({ success: true, state: withCircle('admin') });
    render(<CirclesScreen />);
    const circle = await screen.findByRole('region', { name: 'Garden club' });
    expect(within(circle).getByText(/2 members · 0 online/)).toBeTruthy();

    fireEvent.click(within(circle).getByRole('button', { name: 'Invite someone' }));
    expect((await within(circle).findByLabelText('Invite code')).textContent).toBe('yry-code');

    fireEvent.click(within(circle).getByRole('button', { name: 'Make admin' }));
    expect(setRole).toHaveBeenCalledWith({ key: 'c'.repeat(64), identity: 'b'.repeat(64), role: 'admin' });

    fireEvent.click(within(circle).getByRole('button', { name: 'Remove' }));
    const sheet = screen.getByRole('dialog', { name: 'Remove Bo?' });
    expect(within(sheet).getByText(/already received stays with them/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove' }));
    expect(removeMember).toHaveBeenCalledWith({ key: 'c'.repeat(64), identity: 'b'.repeat(64) });
  });

  it('gives a member no admin controls', async () => {
    getState.mockResolvedValue(withCircle('member'));
    render(<CirclesScreen />);
    const circle = await screen.findByRole('region', { name: 'Garden club' });
    expect(within(circle).queryByRole('button', { name: 'Invite someone' })).toBeNull();
    expect(within(circle).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(within(circle).getByRole('button', { name: 'Leave' })).toBeTruthy();
    expect(within(circle).getByRole('img', { name: 'Offline' })).toBeTruthy();
  });

  it('lists members’ shared models and saves what the user accepts from each provider', async () => {
    const base = withCircle('member');
    const bo = 'b'.repeat(64);
    const state: CirclesState = {
      ...base,
      snapshot: {
        ...base.snapshot,
        circles: [
          {
            ...base.snapshot.circles[0],
            offers: [
              {
                identity: bo,
                name: 'Bo',
                isMine: false,
                models: [{ id: 'qwen3-8b', contextLength: 32768, tools: true }],
                available: true,
                away: false,
                online: true,
              },
              { identity: 'a'.repeat(64), name: 'Ada', isMine: true, models: [{ id: 'mine', tools: false }], available: false, away: false, online: true },
            ],
          },
        ],
      },
      providers: { [bo]: { private: false, trusted: true } },
    };
    getState.mockResolvedValue(state);
    setProviderSettings.mockResolvedValue({ success: true, state });
    render(<CirclesScreen />);
    const shared = await screen.findByRole('list', { name: 'Shared models' });
    expect(within(shared).getByText('qwen3-8b')).toBeTruthy();
    expect(within(shared).getByText('Paused')).toBeTruthy();
    // Your own offer has no switches; Bo's has both.
    expect(within(shared).getAllByRole('switch')).toHaveLength(2);
    expect(within(shared).getByRole('switch', { name: 'Trusted' }).getAttribute('aria-checked')).toBe('true');
    expect(within(shared).getByText(/sees every prompt it serves/)).toBeTruthy();

    fireEvent.click(within(shared).getByRole('switch', { name: 'Private' }));
    expect(setProviderSettings).toHaveBeenCalledWith({ identity: bo, private: true, trusted: true });
  });
});
