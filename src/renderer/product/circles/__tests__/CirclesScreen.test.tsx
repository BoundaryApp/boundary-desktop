import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CircleSharing, CirclesState } from '../../../../shared/types/circles';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { useAppCommand } from '../../useAppShortcuts';
import { CirclesScreen, NO_SETTINGS, OfferRow } from '../CirclesScreen';

const getState = vi.fn();
const setDisplayName = vi.fn();
const create = vi.fn();
const join = vi.fn();
const createInvite = vi.fn();
const removeMember = vi.fn();
const setRole = vi.fn();
const setProviderSettings = vi.fn();
const setSharing = vi.fn();
const getStatus = vi.fn();
const listConfiguredEndpointModels = vi.fn();
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
    setSharing: (...args: unknown[]) => setSharing(...args),
    onState: (cb: (state: unknown) => void) => {
      push.current = cb;
      return () => undefined;
    },
  },
  onboarding: {
    getStatus: (...args: unknown[]) => getStatus(...args),
    listConfiguredEndpointModels: (...args: unknown[]) => listConfiguredEndpointModels(...args),
  },
});

const NOT_SHARING: CircleSharing = { models: [], circles: [], paused: false, away: false };

const unnamed: CirclesState = {
  status: 'stopped',
  displayName: '',
  snapshot: { identity: '', circles: [] },
  providers: {},
  sharing: NOT_SHARING,
};

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
  sharing: NOT_SHARING,
});

const localConnected = {
  configured: true,
  slots: { local: { configured: true, endpointUrl: 'http://127.0.0.1:11434/v1', modelId: 'qwen3-8b', health: 'reachable' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(unnamed);
  getStatus.mockResolvedValue(localConnected);
  listConfiguredEndpointModels.mockResolvedValue({ success: true, models: [{ id: 'qwen3-8b', contextLength: 32768 }, { id: 'gemma' }] });
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

  it('takes an invite code away once it has been used', async () => {
    const state = withCircle('admin');
    const id = 'f'.repeat(64);
    getState.mockResolvedValue(state);
    createInvite.mockResolvedValue({ success: true, state, invite: { id, code: 'yry-code', expires: Date.now() + 86_400_000 } });
    render(<CirclesScreen />);
    const circle = await screen.findByRole('region', { name: 'Garden club' });
    fireEvent.click(within(circle).getByRole('button', { name: 'Invite someone' }));
    await within(circle).findByLabelText('Invite code');

    const [card] = state.snapshot.circles;
    const invite = { id, expires: Date.now() + 86_400_000, revoked: false, used: false };
    const withInvite = (used: boolean): CirclesState => ({
      ...state,
      snapshot: { ...state.snapshot, circles: [{ ...card, invites: [{ ...invite, used }] }] },
    });
    act(() => push.current?.(withInvite(false)));
    expect(within(circle).getByLabelText('Invite code')).toBeTruthy();
    act(() => push.current?.(withInvite(true)));
    expect(within(circle).queryByLabelText('Invite code')).toBeNull();
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

  it.each([
    [true, true, 'Online', 'bg-ok'],
    [true, false, 'Paused', 'bg-warn'],
    [false, false, 'Offline', 'bg-line'],
    [false, true, 'Offline', 'bg-line'],
  ])('shows an offer online %s and available %s as %s', (online, available, label, colour) => {
    const offer = { identity: 'b'.repeat(64), name: 'Bo', isMine: false, models: [{ id: 'qwen3-8b', tools: true }], available, away: false, online };
    render(<OfferRow offer={offer} settings={NO_SETTINGS} />);
    expect(screen.getByRole('img', { name: label }).className).toContain(colour);
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
              { identity: 'a'.repeat(64), name: 'Ada', isMine: true, models: [{ id: 'mine', tools: true }], available: false, away: false, online: true },
            ],
          },
        ],
      },
      providers: { [bo]: { private: false, trusted: true } },
      sharing: { models: [{ id: 'mine', tools: true }], circles: ['c'.repeat(64)], paused: true, away: false },
    };
    getState.mockResolvedValue(state);
    setProviderSettings.mockResolvedValue({ success: true, state });
    render(<CirclesScreen />);
    const shared = await screen.findByRole('list', { name: 'Shared models' });
    expect(within(shared).getByText('qwen3-8b')).toBeTruthy();
    expect(within(shared).getByText("Paused: members can't use your models")).toBeTruthy();
    // Your own row has one switch, for this Circle; Bo's has both claims.
    expect(within(shared).getAllByRole('switch')).toHaveLength(3);
    expect(within(shared).getByRole('switch', { name: 'Trusted' }).getAttribute('aria-checked')).toBe('true');
    expect(within(shared).getByText(/sees every prompt it serves/)).toBeTruthy();

    fireEvent.click(within(shared).getByRole('switch', { name: 'Private' }));
    expect(setProviderSettings).toHaveBeenCalledWith({ identity: bo, private: true, trusted: true });
  });

  describe('sharing your models', () => {
    const KEY = 'c'.repeat(64);
    const SHARING: CircleSharing = { models: [{ id: 'qwen3-8b', tools: true, contextLength: 32768 }], circles: [KEY], paused: false, away: false };

    /** Mount with this sharing; `setSharing` answers as main does, by pushing the new state. */
    async function mount(sharing: CircleSharing, overrides: Partial<CirclesState> = {}) {
      const state: CirclesState = { ...withCircle('member'), sharing, ...overrides };
      getState.mockResolvedValue(state);
      setSharing.mockImplementation(async (next: CircleSharing) => {
        const pushed = { ...state, sharing: next };
        push.current?.(pushed);
        return { success: true, state: pushed };
      });
      render(<CirclesScreen />);
      const panel = await screen.findByRole('group', { name: 'Share your models' });
      return { panel, circle: await screen.findByRole('region', { name: 'Garden club' }) };
    }

    it('shows nothing to set up for someone in no Circle', async () => {
      getState.mockResolvedValue({ ...unnamed, displayName: 'Ada' });
      render(<CirclesScreen />);
      await screen.findByRole('form', { name: 'New Circle' });
      expect(screen.queryByRole('group', { name: 'Share your models' })).toBeNull();
    });

    it('takes someone sharing nothing through a model and a Circle', async () => {
      const { panel, circle } = await mount(NOT_SHARING);
      expect(within(panel).getByText(/You aren't sharing a model/)).toBeTruthy();
      expect(await within(panel).findByText('32K context')).toBeTruthy();
      expect(within(panel).queryByRole('button', { name: 'Pause sharing' })).toBeNull();
      expect(within(circle).getByText("Members of Garden club can't use your models.")).toBeTruthy();

      await act(async () => fireEvent.click(within(panel).getByRole('checkbox', { name: /qwen3-8b/ })));
      expect(setSharing).toHaveBeenLastCalledWith({ ...NOT_SHARING, models: SHARING.models });
      expect(within(panel).getByText(/Turn on sharing in a Circle below/)).toBeTruthy();

      await act(async () => fireEvent.click(within(circle).getByRole('switch', { name: 'Share with Garden club' })));
      expect(setSharing).toHaveBeenLastCalledWith(SHARING);
      expect(within(panel).getByText('Members of Garden club can use this model while Boundary is open.')).toBeTruthy();
      expect(within(circle).getByRole('img', { name: 'Sharing' })).toBeTruthy();
    });

    it('pauses and resumes, saying so in the panel and the Circle', async () => {
      const { panel, circle } = await mount(SHARING);
      await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Pause sharing' })));
      expect(setSharing).toHaveBeenLastCalledWith({ ...SHARING, paused: true });
      expect(within(panel).getByRole('alert').textContent).toMatch(/Paused: members can't use your models\./);
      expect(within(circle).getByText("Paused: members can't use your models")).toBeTruthy();
      expect(within(circle).getByRole('img', { name: 'Unavailable to members' })).toBeTruthy();

      await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Resume sharing' })));
      expect(setSharing).toHaveBeenLastCalledWith(SHARING);
      expect(within(panel).queryByRole('alert')).toBeNull();
      expect(within(circle).queryByText(/Paused/)).toBeNull();
      expect(within(panel).getByRole('button', { name: 'Pause sharing' })).toBeTruthy();
    });

    it('turns away mode on and says what each state means', async () => {
      const { panel, circle } = await mount(SHARING);
      const away = () => within(panel).getByRole('switch', { name: 'Away mode' });
      expect(within(panel).getByText(/Off: members can't use your models while this Mac sleeps/)).toBeTruthy();

      await act(async () => fireEvent.click(away()));
      expect(setSharing).toHaveBeenLastCalledWith({ ...SHARING, away: true });
      expect(away().getAttribute('aria-checked')).toBe('true');
      expect(within(panel).getByText(/This Mac stays awake/)).toBeTruthy();
      expect(within(circle).getByText('Away mode')).toBeTruthy();

      // Main releases the power-save blocker while paused.
      await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Pause sharing' })));
      expect(within(panel).getByText(/On, but this Mac can sleep while sharing is paused/)).toBeTruthy();
      expect(within(circle).queryByText('Away mode')).toBeNull();

      await act(async () => fireEvent.click(away()));
      expect(setSharing).toHaveBeenLastCalledWith({ ...SHARING, paused: true, away: false });
    });

    it('stops sharing with one Circle and keeps the models', async () => {
      const { circle } = await mount(SHARING);
      await act(async () => fireEvent.click(within(circle).getByRole('switch', { name: 'Share with Garden club' })));
      expect(setSharing).toHaveBeenLastCalledWith({ ...SHARING, circles: [] });
    });

    it('keeps a shared model the server no longer lists, so it can be turned off', async () => {
      const old = { ...SHARING, models: [{ id: 'old-model', tools: true }] };
      const { panel } = await mount(old);
      await act(async () => fireEvent.click(within(panel).getByRole('checkbox', { name: 'old-model' })));
      expect(setSharing).toHaveBeenLastCalledWith({ ...old, models: [] });
    });

    it('says when the local server stops members using a shared model, with pause taking priority', async () => {
      getStatus.mockResolvedValue({ ...localConnected, slots: { local: { ...localConnected.slots.local, health: 'unreachable' } } });
      const { panel } = await mount(SHARING);
      expect((await within(panel).findByRole('alert')).textContent).toMatch(/local model server isn't responding/);
      await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Pause sharing' })));
      expect(within(panel).getByRole('alert').textContent).toMatch(/^Paused/);
    });

    it('says when Circles are not connected', async () => {
      const { panel } = await mount(SHARING, { status: 'starting' });
      expect((await within(panel).findByRole('alert')).textContent).toMatch(/Circles aren't connected: members can't use your models/);
    });

    it.each([
      ['no local server', { configured: false, slots: {} }],
      ['a local server that is not responding', { ...localConnected, slots: { local: { ...localConnected.slots.local, health: 'unreachable' } } }],
    ])('offers no sharing with %s', async (_name, status) => {
      getStatus.mockResolvedValue(status);
      getState.mockResolvedValue({ ...withCircle('member'), sharing: NOT_SHARING });
      render(<CirclesScreen />);
      const circle = await screen.findByRole('region', { name: 'Garden club' });
      await act(async () => undefined);
      expect(screen.queryByRole('group', { name: 'Share your models' })).toBeNull();
      expect(within(circle).queryByRole('switch', { name: 'Share with Garden club' })).toBeNull();
      expect(within(circle).queryByRole('heading', { name: 'Shared models' })).toBeNull();
    });

    it('keeps a Circle switch that is on after the local server goes', async () => {
      getStatus.mockResolvedValue({ configured: false, slots: {} });
      const { circle } = await mount({ ...NOT_SHARING, circles: [KEY] });
      await act(async () => fireEvent.click(within(circle).getByRole('switch', { name: 'Share with Garden club' })));
      expect(setSharing).toHaveBeenLastCalledWith(NOT_SHARING);
    });

    it('sends someone with models chosen but no local server to Settings', async () => {
      getStatus.mockResolvedValue({ configured: false, slots: {} });
      const commands: string[] = [];
      const Listener = () => {
        useAppCommand((command) => commands.push(command));
        return null;
      };
      render(<Listener />);
      const { panel } = await mount({ ...NOT_SHARING, models: SHARING.models });
      expect(await within(panel).findByText(/Connect a local model server in Settings/)).toBeTruthy();
      fireEvent.click(within(panel).getByRole('button', { name: 'Open Settings' }));
      expect(commands).toEqual(['go-settings']);
    });

    it('shows a refusal from main', async () => {
      const { panel } = await mount(NOT_SHARING);
      setSharing.mockResolvedValue({ success: false, error: 'Share at most 32 models.', state: withCircle('member') });
      fireEvent.click(await within(panel).findByRole('checkbox', { name: /gemma/ }));
      expect(await within(panel).findByText('Share at most 32 models.')).toBeTruthy();
    });
  });
});
