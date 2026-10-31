import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CircleSharing, CirclesState } from '../../../../shared/types/circles';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { useAppCommand } from '../../useAppShortcuts';
import type { CirclesSelection } from '../CirclesNav';
import { CirclesScreen } from '../CirclesScreen';

const getState = vi.fn();
const setDisplayName = vi.fn();
const create = vi.fn();
const join = vi.fn();
const cancelJoin = vi.fn();
const createInvite = vi.fn();
const removeMember = vi.fn();
const deleteCircle = vi.fn();
const setRole = vi.fn();
const setProviderSettings = vi.fn();
const setSharing = vi.fn();
const revealDiagnostics = vi.fn();
const getStatus = vi.fn();
const listConfiguredEndpointModels = vi.fn();
const setAppSharedModel = vi.fn();
const setAppFallbacks = vi.fn();
const push = vi.hoisted(() => ({ current: null as ((state: unknown) => void) | null }));

stubElectronAPI({
  circles: {
    getState: (...args: unknown[]) => getState(...args),
    setDisplayName: (...args: unknown[]) => setDisplayName(...args),
    create: (...args: unknown[]) => create(...args),
    join: (...args: unknown[]) => join(...args),
    cancelJoin: (...args: unknown[]) => cancelJoin(...args),
    createInvite: (...args: unknown[]) => createInvite(...args),
    removeMember: (...args: unknown[]) => removeMember(...args),
    delete: (...args: unknown[]) => deleteCircle(...args),
    setRole: (...args: unknown[]) => setRole(...args),
    setProviderSettings: (...args: unknown[]) => setProviderSettings(...args),
    setSharing: (...args: unknown[]) => setSharing(...args),
    revealDiagnostics: (...args: unknown[]) => revealDiagnostics(...args),
    onState: (cb: (state: unknown) => void) => {
      push.current = cb;
      return () => undefined;
    },
  },
  onboarding: {
    getStatus: (...args: unknown[]) => getStatus(...args),
    listConfiguredEndpointModels: (...args: unknown[]) => listConfiguredEndpointModels(...args),
    setAppSharedModel: (...args: unknown[]) => setAppSharedModel(...args),
    setAppFallbacks: (...args: unknown[]) => setAppFallbacks(...args),
    getAppSwitch: async () => ({ appSwitch: null }),
    onAppSwitch: () => () => undefined,
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
        needsUpdate: false,
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

/** Holds the selection as the shell does; `away` stands for visiting another destination. */
function Screen() {
  const [selection, setSelection] = useState<CirclesSelection>(null);
  const [away, setAway] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setAway(!away)}>
        Toggle destination
      </button>
      {away ? null : <CirclesScreen selection={selection} onSelect={setSelection} />}
    </>
  );
}

/** Opens a row in the list, whose accessible name starts with its title. */
async function go(name: string) {
  const nav = screen.getByRole('navigation', { name: 'Circles' });
  fireEvent.click(await within(nav).findByRole('button', { name: new RegExp(`^${name}`) }));
}

describe('CirclesScreen', () => {
  it('says when a Circle needs a newer app', async () => {
    const state = withCircle('member');
    getState.mockResolvedValue({
      ...state,
      snapshot: { ...state.snapshot, circles: [{ ...state.snapshot.circles[0], needsUpdate: true }] },
    });
    render(<Screen />);
    expect(await screen.findByText(/Update the app to see its changes/)).toBeTruthy();
  });

  it('asks for a name before offering to create or join', async () => {
    setDisplayName.mockResolvedValue({ success: true, state: { ...unnamed, displayName: 'Ada' } });
    render(<Screen />);
    expect(await screen.findByLabelText('Your name in Circles')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Start a Circle' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Your name in Circles'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(setDisplayName).toHaveBeenCalledWith({ name: 'Ada' });
    act(() => push.current?.({ ...unnamed, displayName: 'Ada' }));
    expect(await screen.findByRole('form', { name: 'Start a Circle' })).toBeTruthy();
  });

  it('says joining waits for an admin, and shows a refusal', async () => {
    getState.mockResolvedValue({ ...unnamed, displayName: 'Bo' });
    const named = { ...unnamed, displayName: 'Bo' };
    let answer!: (value: unknown) => void;
    join.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<Screen />);
    fireEvent.change(await screen.findByLabelText('Invite code'), { target: { value: ' code ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(join).toHaveBeenCalledWith({ code: ' code ' });
    act(() => push.current?.({ ...named, join: { waiting: true } }));
    expect(await screen.findByRole('heading', { name: 'Waiting for an admin' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Circles' }).textContent).toMatch(/Joining…/);

    // Main holds the join, so it's still there after leaving the destination.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle destination' }));
    getState.mockResolvedValue({ ...named, join: { waiting: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle destination' }));
    expect(await screen.findByRole('heading', { name: 'Waiting for an admin' })).toBeTruthy();

    const refused = { ...named, join: { waiting: false, error: 'That invite has expired. Ask for a new one.' } };
    await act(async () => {
      push.current?.(refused);
      answer({ success: false, error: 'That invite has expired. Ask for a new one.', state: refused });
    });
    expect(screen.getByRole('heading', { name: 'Couldn’t join' })).toBeTruthy();
    expect(screen.getByText('That invite has expired. Ask for a new one.')).toBeTruthy();
  });

  it('lets an admin invite, change roles and remove, saying removal is forward-only', async () => {
    getState.mockResolvedValue(withCircle('admin'));
    createInvite.mockResolvedValue({ success: true, state: withCircle('admin'), invite: { id: 'f'.repeat(64), code: 'yry-code', expires: Date.now() + 7 * 86_400_000 } });
    removeMember.mockResolvedValue({ success: true, state: withCircle('admin') });
    render(<Screen />);
    const circle = await screen.findByRole('region', { name: 'Garden club' });
    expect(within(circle).getByText(/2 members · 1 online/)).toBeTruthy();

    fireEvent.click(within(circle).getByRole('button', { name: 'Invite someone' }));
    const invite = screen.getByRole('dialog', { name: 'Invite to Garden club' });
    fireEvent.change(within(invite).getByLabelText('Who is it for?'), { target: { value: 'Sam' } });
    fireEvent.click(within(invite).getByRole('button', { name: 'Create code' }));
    expect((await within(invite).findByLabelText('Invite code')).textContent).toBe('yry-code');
    expect(createInvite).toHaveBeenCalledWith({ key: 'c'.repeat(64), label: 'Sam' });
    expect(within(invite).getByText(/can't be shown again/)).toBeTruthy();
    fireEvent.click(within(invite).getByRole('button', { name: 'Done' }));

    expect(within(circle).queryByRole('button', { name: 'Make admin' })).toBeNull();
    fireEvent.click(within(circle).getByRole('button', { name: /Bo/ }));
    const panel = screen.getByRole('complementary', { name: 'Bo' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Make admin' }));
    expect(setRole).toHaveBeenCalledWith({ key: 'c'.repeat(64), identity: 'b'.repeat(64), role: 'admin' });

    fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }));
    const sheet = screen.getByRole('dialog', { name: 'Remove Bo?' });
    expect(within(sheet).getByText(/already received stays with them/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove' }));
    expect(removeMember).toHaveBeenCalledWith({ key: 'c'.repeat(64), identity: 'b'.repeat(64) });
  });

  it('offers Delete Circle in place of Leave only to a Circle’s last member', async () => {
    const shared = withCircle('admin');
    getState.mockResolvedValue(shared);
    render(<Screen />);
    const circle = await screen.findByRole('region', { name: 'Garden club' });
    expect(within(circle).getByRole('button', { name: 'Leave' })).toBeTruthy();
    expect(within(circle).queryByRole('button', { name: 'Delete Circle' })).toBeNull();

    const [only] = shared.snapshot!.circles;
    const alone: CirclesState = {
      ...shared,
      snapshot: { ...shared.snapshot!, circles: [{ ...only, members: only.members.filter((member) => member.isMe) }] },
    };
    deleteCircle.mockResolvedValue({ success: true, state: alone });
    act(() => push.current?.(alone));
    expect(within(circle).queryByRole('button', { name: 'Leave' })).toBeNull();

    fireEvent.click(within(circle).getByRole('button', { name: 'Delete Circle' }));
    const sheet = screen.getByRole('dialog', { name: 'Delete Garden club?' });
    expect(within(sheet).getByText(/you can’t get it back/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete Circle' }));
    expect(deleteCircle).toHaveBeenCalledWith({ key: 'c'.repeat(64) });
  });

  it('takes an invite code away once it has been used', async () => {
    const state = withCircle('admin');
    const id = 'f'.repeat(64);
    getState.mockResolvedValue(state);
    createInvite.mockResolvedValue({ success: true, state, invite: { id, code: 'yry-code', expires: Date.now() + 86_400_000 } });
    render(<Screen />);
    const circle = await screen.findByRole('region', { name: 'Garden club' });
    fireEvent.click(within(circle).getByRole('button', { name: 'Invite someone' }));
    const sheet = screen.getByRole('dialog', { name: 'Invite to Garden club' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create code' }));
    await within(sheet).findByLabelText('Invite code');

    const [card] = state.snapshot.circles;
    const invite = { id, expires: Date.now() + 86_400_000, revoked: false, used: false };
    const withInvite = (used: boolean): CirclesState => ({
      ...state,
      snapshot: { ...state.snapshot, circles: [{ ...card, invites: [{ ...invite, used }] }] },
    });
    act(() => push.current?.(withInvite(false)));
    expect(within(sheet).getByLabelText('Invite code')).toBeTruthy();
    act(() => push.current?.(withInvite(true)));
    expect(within(sheet).queryByLabelText('Invite code')).toBeNull();
  });

  it('names open invites by their label, and says which admins must be online', async () => {
    const base = withCircle('admin');
    const [card] = base.snapshot.circles;
    const id = 'f'.repeat(64);
    getState.mockResolvedValue({
      ...base,
      inviteLabels: { [id]: 'Sam' },
      snapshot: {
        ...base.snapshot,
        circles: [
          {
            ...card,
            members: [card.members[0], { ...card.members[1], role: 'admin' }],
            invites: [{ id, expires: Date.now() + 2 * 86_400_000, revoked: false, used: false }],
          },
        ],
      },
    });
    render(<Screen />);
    const circle = await screen.findByRole('region', { name: 'Garden club' });
    expect(within(circle).getByText(/For Sam, waiting to be used/)).toBeTruthy();
    fireEvent.click(within(circle).getByRole('button', { name: 'Manage' }));
    const sheet = screen.getByRole('dialog', { name: 'Invite to Garden club' });
    expect(within(sheet).getByText(/when they use it: you or Bo/)).toBeTruthy();
    expect(within(within(sheet).getByRole('list', { name: 'Open invites' })).getByText('For Sam')).toBeTruthy();
  });

  it('gives a member no admin controls', async () => {
    getState.mockResolvedValue(withCircle('member'));
    render(<Screen />);
    const circle = await screen.findByRole('region', { name: 'Garden club' });
    expect(within(circle).queryByRole('button', { name: 'Invite someone' })).toBeNull();
    fireEvent.click(within(circle).getByRole('button', { name: /Bo/ }));
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make admin' })).toBeNull();
    expect(within(circle).getByRole('button', { name: 'Leave' })).toBeTruthy();
    expect(within(circle).getByRole('img', { name: 'Offline' })).toBeTruthy();
  });

  describe('people and what they share', () => {
    const KEY = 'c'.repeat(64);
    const SECOND = 'd'.repeat(64);
    const bo = 'b'.repeat(64);
    const offer = { identity: bo, name: 'Bo', isMine: false, models: [{ id: 'qwen3-8b', contextLength: 32768, tools: true }], available: true, away: false, online: true };
    const entry = { slot: 'peer', modelId: 'qwen3-8b', peer: { circleId: KEY, providerId: bo } };

    function offering(overrides: Partial<CirclesState> = {}, role: 'admin' | 'member' = 'member'): CirclesState {
      const base = withCircle(role);
      const [circle] = base.snapshot.circles;
      return {
        ...base,
        snapshot: { ...base.snapshot, circles: [{ ...circle, members: [circle.members[0], { ...circle.members[1], online: true }], offers: [offer] }] },
        ...overrides,
      };
    }

    async function openBo(state: CirclesState) {
      getState.mockResolvedValue(state);
      render(<Screen />);
      const circle = await screen.findByRole('region', { name: 'Garden club' });
      fireEvent.click(within(circle).getByRole('button', { name: /Bo/ }));
      return { circle, panel: screen.getByRole('complementary', { name: 'Bo' }) };
    }

    it.each([
      [true, true, 'Online', 'bg-ok'],
      [true, false, 'Paused', 'bg-warn'],
      [false, false, 'Offline', 'bg-line'],
      [false, true, 'Offline', 'bg-line'],
    ])('shows an offer online %s and available %s as %s', async (online, available, label, colour) => {
      const state = offering();
      const [circle] = state.snapshot.circles;
      circle.members[1] = { ...circle.members[1], online };
      circle.offers = [{ ...offer, online, available }];
      getState.mockResolvedValue(state);
      render(<Screen />);
      const people = await screen.findByRole('list', { name: 'People' });
      const bosRow = within(people).getByRole('button', { name: /Bo/ });
      expect(within(bosRow).getByRole('img', { name: label }).className).toContain(colour);
    });

    it('shows a person’s models and whether they’re trusted on their row', async () => {
      getState.mockResolvedValue(offering({ providers: { [bo]: { private: false, trusted: true } } }));
      render(<Screen />);
      const people = await screen.findByRole('list', { name: 'People' });
      expect(within(people).getByText('qwen3-8b')).toBeTruthy();
      expect(within(people).getByText('Trusted')).toBeTruthy();
    });

    it('saves what the user accepts from a provider', async () => {
      const state = offering({ providers: { [bo]: { private: false, trusted: true } } });
      setProviderSettings.mockResolvedValue({ success: true, state });
      const { panel } = await openBo(state);
      expect(within(panel).getByRole('switch', { name: 'Trusted' }).getAttribute('aria-checked')).toBe('true');
      expect(within(panel).getByText(/sees every prompt it serves/)).toBeTruthy();
      fireEvent.click(within(panel).getByRole('switch', { name: 'Allow in private projects' }));
      expect(setProviderSettings).toHaveBeenCalledWith({ identity: bo, private: true, trusted: true });
    });

    it('holds a model back until its provider is trusted', async () => {
      const { panel } = await openBo(offering());
      expect(within(panel).getByRole<HTMLButtonElement>('button', { name: 'Use as default' }).disabled).toBe(true);
      expect(within(panel).getByText('Trust Bo to use this model.')).toBeTruthy();
    });

    it('makes a trusted provider’s model the default', async () => {
      const usingBo = { ...localConnected, appDefault: null, appSharedModel: entry, appFallbacks: [] };
      setAppSharedModel.mockResolvedValue({ success: true, status: usingBo });
      const { panel } = await openBo(offering({ providers: { [bo]: { private: false, trusted: true } } }));
      await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Use as default' })));
      expect(setAppSharedModel).toHaveBeenCalledWith({ entry });
      expect(await within(panel).findByText('Your default model')).toBeTruthy();
    });

    it('shows main’s refusal', async () => {
      setAppSharedModel.mockResolvedValue({ success: false, error: 'Bo isn’t sharing it.', status: localConnected });
      const { panel } = await openBo(offering({ providers: { [bo]: { private: false, trusted: true } } }));
      await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Use as default' })));
      expect(await within(panel).findByText('Bo isn’t sharing it.')).toBeTruthy();
    });

    it('adds the model to the fallbacks, once', async () => {
      const connected = { ...localConnected, appDefault: 'local', appFallbacks: [] };
      getStatus.mockResolvedValue(connected);
      setAppFallbacks.mockResolvedValue({ success: true, status: { ...connected, appFallbacks: [entry] } });
      const { panel } = await openBo(offering({ providers: { [bo]: { private: false, trusted: true } } }));
      fireEvent.click(await within(panel).findByRole('button', { name: 'Add as fallback' }));
      await act(async () => undefined);
      expect(setAppFallbacks).toHaveBeenCalledWith({ fallbacks: [entry] });
      expect(within(panel).getByRole<HTMLButtonElement>('button', { name: 'In your fallbacks' }).disabled).toBe(true);
    });

    it('says a default provider who lost trust leaves chats waiting', async () => {
      getStatus.mockResolvedValue({ ...localConnected, appDefault: null, appSharedModel: entry, appFallbacks: [] });
      const { panel } = await openBo(offering());
      expect(await within(panel).findByText(/Still your default, but chats can't use it until you trust Bo/)).toBeTruthy();
    });

    it('shows a person in two Circles once, using a Circle where the model answers', async () => {
      const base = offering({ providers: { [bo]: { private: false, trusted: true } } });
      const [first] = base.snapshot.circles;
      const state: CirclesState = {
        ...base,
        snapshot: {
          ...base.snapshot,
          circles: [
            { ...first, offers: [{ ...offer, available: false }] },
            { ...first, key: SECOND, name: 'Book group', offers: [offer] },
          ],
        },
      };
      setAppSharedModel.mockResolvedValue({ success: true, status: localConnected });
      const { panel } = await openBo(state);
      expect(within(panel).getAllByRole('switch')).toHaveLength(2);
      expect(within(panel).getByText(/In Garden club, Book group/)).toBeTruthy();
      expect(within(panel).getAllByText('qwen3-8b')).toHaveLength(1);
      await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Use as default' })));
      expect(setAppSharedModel).toHaveBeenCalledWith({ entry: { ...entry, peer: { circleId: SECOND, providerId: bo } } });
    });

    it('lists each person’s model once across Circles, and opens their panel from Sharing', async () => {
      const base = offering({}, 'admin');
      const [first] = base.snapshot.circles;
      const state: CirclesState = {
        ...base,
        snapshot: { ...base.snapshot, circles: [first, { ...first, key: SECOND, name: 'Book group' }] },
      };
      getState.mockResolvedValue(state);
      render(<Screen />);
      await go('Sharing');
      const offers = await screen.findByRole('list', { name: 'Models from your Circles' });
      expect(within(offers).getAllByRole('button')).toHaveLength(1);
      expect(within(offers).getByText('Bo · 32K context · Garden club, Book group')).toBeTruthy();
      expect(within(offers).getByText('Not trusted')).toBeTruthy();

      fireEvent.click(within(offers).getByRole('button', { name: /qwen3-8b/ }));
      const panel = screen.getByRole('complementary', { name: 'Bo' });
      expect(within(panel).getByRole('switch', { name: 'Trusted' })).toBeTruthy();
      // Membership actions need a Circle, so they stay on its page.
      expect(within(panel).queryByRole('button', { name: 'Remove' })).toBeNull();
    });

    it.each([
      ['Ready', offer, { [bo]: { private: false, trusted: true } }],
      ['Paused', { ...offer, available: false }, { [bo]: { private: false, trusted: true } }],
      ['Offline', { ...offer, online: false }, { [bo]: { private: false, trusted: true } }],
      ['Not trusted', offer, {}],
    ])('says %s for an offered model', async (label, shown, providers) => {
      const state = offering({ providers });
      state.snapshot.circles[0].offers = [shown];
      getState.mockResolvedValue(state);
      render(<Screen />);
      await go('Sharing');
      const offers = await screen.findByRole('list', { name: 'Models from your Circles' });
      expect(await within(offers).findByText(label)).toBeTruthy();
    });

    it('opens the person a link names', async () => {
      const state = offering({}, 'admin');
      getState.mockResolvedValue(state);
      render(<Screen />);
      await screen.findByRole('region', { name: 'Garden club' });
      fireEvent.click(screen.getByRole('button', { name: 'Toggle destination' }));
      cleanup();
      render(<CirclesScreen selection={{ kind: 'sharing', person: bo }} onSelect={() => undefined} />);
      const panel = await screen.findByRole('complementary', { name: 'Bo' });
      expect(within(panel).getByRole('switch', { name: 'Trusted' })).toBeTruthy();
    });

    it('closes the panel when the person leaves', async () => {
      const state = offering();
      await openBo(state);
      const [circle] = state.snapshot.circles;
      act(() => push.current?.({ ...state, snapshot: { ...state.snapshot, circles: [{ ...circle, members: circle.members.slice(0, 1), offers: [] }] } }));
      expect(screen.queryByRole('complementary', { name: 'Bo' })).toBeNull();
    });

    it('offers a person who shares nothing only an admin’s actions', async () => {
      const state = offering({}, 'admin');
      state.snapshot.circles[0].offers = [];
      const { panel } = await openBo(state);
      expect(within(panel).queryByRole('switch')).toBeNull();
      expect(within(panel).getByRole('button', { name: 'Remove' })).toBeTruthy();
    });
  });

  describe('the list', () => {
    const second = 'd'.repeat(64);
    const twoCircles = (): CirclesState => {
      const base = withCircle('admin');
      const [first] = base.snapshot.circles;
      return { ...base, snapshot: { ...base.snapshot, circles: [first, { ...first, key: second, name: 'Book group' }] } };
    };

    it('shows one Circle at a time and keeps the choice across destinations', async () => {
      getState.mockResolvedValue(twoCircles());
      render(<Screen />);
      await screen.findByRole('region', { name: 'Garden club' });
      expect(screen.queryByRole('region', { name: 'Book group' })).toBeNull();

      await go('Book group');
      expect(await screen.findByRole('region', { name: 'Book group' })).toBeTruthy();
      expect(screen.queryByRole('region', { name: 'Garden club' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Toggle destination' }));
      expect(screen.queryByRole('region', { name: 'Book group' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Toggle destination' }));
      expect(await screen.findByRole('region', { name: 'Book group' })).toBeTruthy();
    });

    it('falls back to the first Circle when the selected one goes', async () => {
      const state = twoCircles();
      getState.mockResolvedValue(state);
      render(<Screen />);
      await go('Book group');
      await screen.findByRole('region', { name: 'Book group' });
      act(() => push.current?.({ ...state, snapshot: { ...state.snapshot, circles: state.snapshot.circles.slice(0, 1) } }));
      expect(await screen.findByRole('region', { name: 'Garden club' })).toBeTruthy();
    });

    it('shows someone who can’t share only what’s offered to them', async () => {
      getStatus.mockResolvedValue({ configured: false, slots: {} });
      getState.mockResolvedValue(withCircle('member'));
      render(<Screen />);
      await screen.findByRole('region', { name: 'Garden club' });
      await act(async () => undefined);
      await go('Sharing');
      expect(await screen.findByRole('region', { name: 'From your Circles' })).toBeTruthy();
      expect(screen.getByText('Nobody in your Circles is sharing a model yet.')).toBeTruthy();
      expect(screen.queryByRole('group', { name: 'Shared from this Mac' })).toBeNull();
    });

    it('adds a Circle from the sheet and opens it', async () => {
      const state = withCircle('admin');
      getState.mockResolvedValue(state);
      create.mockResolvedValue({ success: true, state, key: second });
      render(<Screen />);
      await screen.findByRole('region', { name: 'Garden club' });
      fireEvent.click(screen.getByRole('button', { name: 'Add a Circle' }));
      const sheet = screen.getByRole('dialog', { name: 'Add a Circle' });
      fireEvent.change(within(sheet).getByLabelText('Circle name'), { target: { value: 'Book group' } });
      await act(async () => fireEvent.click(within(sheet).getByRole('button', { name: 'Create' })));
      expect(create).toHaveBeenCalledWith({ name: 'Book group' });
      expect(screen.queryByRole('dialog', { name: 'Add a Circle' })).toBeNull();

      const [first] = state.snapshot.circles;
      act(() => push.current?.({ ...state, snapshot: { ...state.snapshot, circles: [first, { ...first, key: second, name: 'Book group' }] } }));
      expect(await screen.findByRole('region', { name: 'Book group' })).toBeTruthy();
    });

    it('moves a join to its own page, cancels it, and opens the Circle when it succeeds', async () => {
      const state = withCircle('member');
      getState.mockResolvedValue(state);
      let answer!: (value: unknown) => void;
      join.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      cancelJoin.mockResolvedValue({ success: true, state });
      render(<Screen />);
      await screen.findByRole('region', { name: 'Garden club' });
      fireEvent.click(screen.getByRole('button', { name: 'Add a Circle' }));
      const sheet = screen.getByRole('dialog', { name: 'Add a Circle' });
      fireEvent.change(within(sheet).getByLabelText('Invite code'), { target: { value: 'code' } });
      fireEvent.click(within(sheet).getByRole('button', { name: 'Join' }));
      expect(screen.queryByRole('dialog', { name: 'Add a Circle' })).toBeNull();
      act(() => push.current?.({ ...state, join: { waiting: true } }));
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      expect(cancelJoin).toHaveBeenCalled();

      const [first] = state.snapshot.circles;
      const joined = { ...state, join: null, snapshot: { ...state.snapshot, circles: [first, { ...first, key: second, name: 'Book group' }] } };
      await act(async () => {
        push.current?.(joined);
        answer({ success: true, state: joined, key: second });
      });
      expect(await screen.findByRole('region', { name: 'Book group' })).toBeTruthy();
    });

    it('holds the name and diagnostics in Profile', async () => {
      getState.mockResolvedValue(withCircle('member'));
      revealDiagnostics.mockResolvedValue({ success: false, error: 'No file yet.' });
      render(<Screen />);
      await screen.findByRole('region', { name: 'Garden club' });
      expect(screen.getByRole('navigation', { name: 'Circles' }).textContent).toMatch(/Ada · Connected/);
      expect(screen.queryByRole('button', { name: 'Show diagnostics file' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Profile' }));
      const sheet = screen.getByRole('dialog', { name: 'Profile' });
      expect((within(sheet).getByLabelText('Your name in Circles') as HTMLInputElement).value).toBe('Ada');
      fireEvent.click(within(sheet).getByRole('button', { name: 'Show diagnostics file' }));
      expect(await within(sheet).findByText('No file yet.')).toBeTruthy();
    });
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
      render(<Screen />);
      await screen.findByRole('region', { name: 'Garden club' });
    }

    async function openSharing() {
      await go('Sharing');
      return screen.findByRole('group', { name: 'Shared from this Mac' });
    }

    async function openCircle() {
      await go('Garden club');
      return screen.findByRole('region', { name: 'Garden club' });
    }

    it('shows nothing to set up for someone in no Circle', async () => {
      getState.mockResolvedValue({ ...unnamed, displayName: 'Ada' });
      render(<Screen />);
      await screen.findByRole('form', { name: 'Start a Circle' });
      expect(screen.queryByRole('group', { name: 'Shared from this Mac' })).toBeNull();
    });

    it('takes someone sharing nothing through a model and a Circle', async () => {
      await mount(NOT_SHARING);
      let circle = await openCircle();
      expect(await within(circle).findByText("Members of Garden club can't use your models.")).toBeTruthy();

      let panel = await openSharing();
      expect(within(panel).getByText(/You aren't sharing a model/)).toBeTruthy();
      expect(await within(panel).findByText('32K context')).toBeTruthy();
      expect(within(panel).queryByRole('button', { name: 'Pause sharing' })).toBeNull();

      await act(async () => fireEvent.click(within(panel).getByRole('checkbox', { name: /qwen3-8b/ })));
      expect(setSharing).toHaveBeenLastCalledWith({ ...NOT_SHARING, models: SHARING.models });
      expect(within(panel).getByText(/Turn on a Circle below/)).toBeTruthy();

      circle = await openCircle();
      await act(async () => fireEvent.click(within(circle).getByRole('switch', { name: 'Share here' })));
      expect(setSharing).toHaveBeenLastCalledWith(SHARING);
      expect(within(circle).getByRole('img', { name: 'Sharing' })).toBeTruthy();

      panel = await openSharing();
      expect(within(panel).getByText('Members of Garden club can use this model while Boundary is open.')).toBeTruthy();
    });

    it('pauses and resumes, saying so in the panel and the Circle', async () => {
      await mount(SHARING);
      let panel = await openSharing();
      await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Pause sharing' })));
      expect(setSharing).toHaveBeenLastCalledWith({ ...SHARING, paused: true });
      expect(within(panel).getByRole('alert').textContent).toMatch(/Paused: members can't use your models\./);
      const nav = screen.getByRole('navigation', { name: 'Circles' });
      expect(within(nav).getByRole('button', { name: /^Sharing\s*Paused/ })).toBeTruthy();

      let circle = await openCircle();
      expect(within(circle).getByText("Paused: members can't use your models")).toBeTruthy();
      expect(within(circle).getByRole('img', { name: 'Unavailable to members' })).toBeTruthy();

      panel = await openSharing();
      await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Resume sharing' })));
      expect(setSharing).toHaveBeenLastCalledWith(SHARING);
      expect(within(panel).queryByRole('alert')).toBeNull();
      expect(within(panel).getByRole('button', { name: 'Pause sharing' })).toBeTruthy();

      circle = await openCircle();
      expect(within(circle).queryByText(/Paused/)).toBeNull();
    });

    it('turns away mode on and says what each state means', async () => {
      await mount(SHARING);
      let panel = await openSharing();
      const away = () => within(panel).getByRole('switch', { name: 'Away mode' });
      expect(within(panel).getByText(/Off: members can't use your models while this Mac sleeps/)).toBeTruthy();

      await act(async () => fireEvent.click(away()));
      expect(setSharing).toHaveBeenLastCalledWith({ ...SHARING, away: true });
      expect(away().getAttribute('aria-checked')).toBe('true');
      expect(within(panel).getByText(/This Mac stays awake/)).toBeTruthy();
      expect(within(await openCircle()).getByText('Away mode')).toBeTruthy();

      // Main releases the power-save blocker while paused.
      panel = await openSharing();
      await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Pause sharing' })));
      expect(within(panel).getByText(/On, but this Mac can sleep while sharing is paused/)).toBeTruthy();
      expect(within(await openCircle()).queryByText('Away mode')).toBeNull();

      panel = await openSharing();
      await act(async () => fireEvent.click(away()));
      expect(setSharing).toHaveBeenLastCalledWith({ ...SHARING, paused: true, away: false });
    });

    it('keeps Sharing’s switch and a Circle’s Share here the same', async () => {
      await mount({ ...SHARING, circles: [] });
      let panel = await openSharing();
      const onSharing = () => within(panel).getByRole('switch', { name: 'Share with Garden club' });
      await act(async () => fireEvent.click(onSharing()));
      expect(setSharing).toHaveBeenLastCalledWith(SHARING);
      expect(onSharing().getAttribute('aria-checked')).toBe('true');

      const circle = await openCircle();
      const here = await within(circle).findByRole('switch', { name: 'Share here' });
      expect(here.getAttribute('aria-checked')).toBe('true');
      await act(async () => fireEvent.click(here));
      expect(setSharing).toHaveBeenLastCalledWith({ ...SHARING, circles: [] });

      panel = await openSharing();
      expect(onSharing().getAttribute('aria-checked')).toBe('false');
    });

    it('stops sharing with one Circle and keeps the models', async () => {
      await mount(SHARING);
      const circle = await openCircle();
      await act(async () => fireEvent.click(await within(circle).findByRole('switch', { name: 'Share here' })));
      expect(setSharing).toHaveBeenLastCalledWith({ ...SHARING, circles: [] });
    });

    it('keeps a shared model the server no longer lists, so it can be turned off', async () => {
      const old = { ...SHARING, models: [{ id: 'old-model', tools: true }] };
      await mount(old);
      const panel = await openSharing();
      await act(async () => fireEvent.click(within(panel).getByRole('checkbox', { name: 'old-model' })));
      expect(setSharing).toHaveBeenLastCalledWith({ ...old, models: [] });
    });

    it('says when the local server stops members using a shared model, with pause taking priority', async () => {
      getStatus.mockResolvedValue({ ...localConnected, slots: { local: { ...localConnected.slots.local, health: 'unreachable' } } });
      await mount(SHARING);
      const panel = await openSharing();
      expect((await within(panel).findByRole('alert')).textContent).toMatch(/local model server isn't responding/);
      await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Pause sharing' })));
      expect(within(panel).getByRole('alert').textContent).toMatch(/^Paused/);
    });

    it('says when Circles are not connected', async () => {
      await mount(SHARING, { status: 'starting' });
      const panel = await openSharing();
      expect((await within(panel).findByRole('alert')).textContent).toMatch(/Circles aren't connected: members can't use your models/);
    });

    it.each([
      ['no local server', { configured: false, slots: {} }],
      ['a local server that is not responding', { ...localConnected, slots: { local: { ...localConnected.slots.local, health: 'unreachable' } } }],
    ])('offers no sharing with %s', async (_name, status) => {
      getStatus.mockResolvedValue(status);
      getState.mockResolvedValue({ ...withCircle('member'), sharing: NOT_SHARING });
      render(<Screen />);
      const circle = await screen.findByRole('region', { name: 'Garden club' });
      await act(async () => undefined);
      expect(screen.queryByRole('group', { name: 'Shared from this Mac' })).toBeNull();
      expect(within(circle).queryByRole('switch', { name: 'Share here' })).toBeNull();
      expect(within(circle).queryByRole('heading', { name: 'Shared models' })).toBeNull();
    });

    it('keeps a Circle switch that is on after the local server goes', async () => {
      getStatus.mockResolvedValue({ configured: false, slots: {} });
      await mount({ ...NOT_SHARING, circles: [KEY] });
      const circle = await openCircle();
      await act(async () => fireEvent.click(await within(circle).findByRole('switch', { name: 'Share here' })));
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
      await mount({ ...NOT_SHARING, models: SHARING.models });
      const panel = await openSharing();
      expect(await within(panel).findByText(/Connect a local model server in Settings/)).toBeTruthy();
      fireEvent.click(within(panel).getByRole('button', { name: 'Open Settings' }));
      expect(commands).toEqual(['go-settings']);
    });

    it('shows a refusal from main', async () => {
      await mount(NOT_SHARING);
      const panel = await openSharing();
      setSharing.mockResolvedValue({ success: false, error: 'Share at most 32 models.', state: withCircle('member') });
      fireEvent.click(await within(panel).findByRole('checkbox', { name: /gemma/ }));
      expect(await within(panel).findByText('Share at most 32 models.')).toBeTruthy();
    });
  });
});
