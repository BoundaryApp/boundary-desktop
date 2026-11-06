import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CirclesState } from '../../../../shared/types/circles';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { InviteSheet, useInviteHints } from '../InviteSheet';
import { useCirclesState } from '../useCircles';

const getState = vi.fn();
const createInvite = vi.fn();
const inviteHints = vi.fn();
const inviteCode = vi.fn();
const revokeInvite = vi.fn();
const push = vi.hoisted(() => ({ current: null as ((state: unknown) => void) | null }));

stubElectronAPI({
  circles: {
    getState: (...args: unknown[]) => getState(...args),
    createInvite: (...args: unknown[]) => createInvite(...args),
    inviteHints: (...args: unknown[]) => inviteHints(...args),
    inviteCode: (...args: unknown[]) => inviteCode(...args),
    revokeInvite: (...args: unknown[]) => revokeInvite(...args),
    onState: (cb: (state: unknown) => void) => {
      push.current = cb;
      return () => undefined;
    },
  },
});

const KEY = 'c'.repeat(64);
const CODE = 'yrb7ei1ng-the-rest-of-the-code';
const mine = 'f'.repeat(64);
const theirs = 'e'.repeat(64);

const admin: CirclesState = {
  status: 'running',
  displayName: 'Ada',
  snapshot: {
    identity: 'a'.repeat(64),
    circles: [
      {
        key: KEY,
        name: 'Garden club',
        myRole: 'admin',
        members: [
          { identity: 'a'.repeat(64), name: 'Ada', role: 'admin', isMe: true, online: true },
          { identity: 'b'.repeat(64), name: 'Bo', role: 'member', isMe: false, online: false },
        ],
        invites: [],
        offers: [],
        needsUpdate: false,
        writable: true,
      },
    ],
  },
  providers: {},
  sharing: { models: [], circles: [], paused: false, away: false },
};

const open = (id: string) => ({ id, expires: Date.now() + 2 * 86_400_000, revoked: false, used: false });

function stateWith(patch: Partial<CirclesState>, ids: string[], admins = false): CirclesState {
  const [circle] = admin.snapshot.circles;
  const members = admins ? [circle.members[0], { ...circle.members[1], role: 'admin' as const }] : circle.members;
  return { ...admin, ...patch, snapshot: { ...admin.snapshot, circles: [{ ...circle, members, invites: ids.map(open) }] } };
}

/** The sheet as the Circle tab mounts it, with a button that opens it. */
function Host() {
  const state = useCirclesState();
  const circle = state.snapshot.circles[0];
  const hints = useInviteHints(circle?.key, state.inviteCodeIds);
  const [shown, setShown] = useState(false);
  if (!circle) return null;
  return (
    <>
      <button type="button" onClick={() => setShown(true)}>
        Invite someone
      </button>
      <InviteSheet circle={circle} circles={state} hints={hints} open={shown} onClose={() => setShown(false)} />
    </>
  );
}

async function openSheet(state: CirclesState) {
  getState.mockResolvedValue(state);
  inviteHints.mockResolvedValue({ success: true, state, hints: { [mine]: CODE.slice(0, 9) } });
  inviteCode.mockResolvedValue({ success: true, state, code: CODE });
  render(<Host />);
  fireEvent.click(await screen.findByRole('button', { name: 'Invite someone' }));
  return screen.getByRole('dialog', { name: 'Invite to Garden club' });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('InviteSheet', () => {
  it('creates a code for a name, and keeps it behind the list once made', async () => {
    createInvite.mockResolvedValue({ success: true, state: admin, invite: { id: mine, code: 'yry-code', expires: Date.now() + 7 * 86_400_000, kept: true, stillOpen: 0 } });
    const sheet = await openSheet(admin);
    fireEvent.change(within(sheet).getByLabelText('Who is it for?'), { target: { value: 'Sam' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create code' }));
    expect((await within(sheet).findByLabelText('Invite code')).textContent).toBe('yry-code');
    expect(createInvite).toHaveBeenCalledWith({ key: KEY, label: 'Sam' });
    expect(within(sheet).getByText(/Copy it again from the list below/)).toBeTruthy();
  });

  it('takes an invite code away once it has been used', async () => {
    createInvite.mockResolvedValue({ success: true, state: admin, invite: { id: mine, code: 'yry-code', expires: Date.now() + 86_400_000, kept: true, stillOpen: 0 } });
    const sheet = await openSheet(admin);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create code' }));
    await within(sheet).findByLabelText('Invite code');
    act(() => push.current?.(stateWith({}, [mine])));
    expect(within(sheet).getByLabelText('Invite code')).toBeTruthy();
    const used = stateWith({}, []);
    used.snapshot.circles[0].invites = [{ ...open(mine), used: true }];
    act(() => push.current?.(used));
    expect(within(sheet).queryByLabelText('Invite code')).toBeNull();
  });

  it('names open invites by their label, and says which admins must be online', async () => {
    const sheet = await openSheet(stateWith({ inviteLabels: { [theirs]: 'Sam' } }, [theirs], true));
    expect(within(sheet).getByText(/when they use it: you or Bo/)).toBeTruthy();
    expect(within(within(sheet).getByRole('list', { name: 'Open invites' })).getByText('For Sam')).toBeTruthy();
  });

  it('shows a kept code masked until Show, and others without controls', async () => {
    const sheet = await openSheet(stateWith({ inviteLabels: { [mine]: 'Sam' }, inviteCodeIds: [mine] }, [mine, theirs]));
    const list = within(sheet).getByRole('list', { name: 'Open invites' });
    const row = (await within(list).findByText('For Sam · yrb7ei1ng…')).closest('li')!;
    expect(inviteHints).toHaveBeenCalledWith({ key: KEY });
    expect(inviteCode).not.toHaveBeenCalled();
    expect(sheet.textContent).not.toContain(CODE);

    const other = within(list).getByText(`Invite ${theirs.slice(0, 6)}`).closest('li')!;
    expect(within(other).queryByRole('button', { name: 'Show' })).toBeNull();
    expect(within(other).queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(within(other).getByRole('button', { name: 'Revoke' })).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: 'Show' }));
    expect(await within(row).findByText(CODE)).toBeTruthy();
    expect(inviteCode).toHaveBeenCalledWith({ key: KEY, inviteId: mine });
    fireEvent.click(within(row).getByRole('button', { name: 'Hide' }));
    expect(within(row).queryByText(CODE)).toBeNull();
  });

  it('copies a kept code without showing it', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const sheet = await openSheet(stateWith({ inviteCodeIds: [mine] }, [mine]));
    const row = (await within(sheet).findByText('Invite yrb7ei1ng…')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Copy' }));
    expect(await within(row).findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(row.textContent).not.toContain(CODE);
    vi.unstubAllGlobals();
  });

  it('fetches no codes when this device keeps none', async () => {
    const sheet = await openSheet(stateWith({}, [theirs]));
    expect(within(sheet).getByText(`Invite ${theirs.slice(0, 6)}`)).toBeTruthy();
    expect(inviteHints).not.toHaveBeenCalled();
  });

  it('says before creating that a name replaces an open code', async () => {
    const sheet = await openSheet(stateWith({ inviteLabels: { [mine]: 'Sam' }, inviteCodeIds: [mine] }, [mine]));
    const name = within(sheet).getByLabelText('Who is it for?');
    expect(within(sheet).queryByText(/Replaces/)).toBeNull();
    fireEvent.change(name, { target: { value: ' sAM ' } });
    expect(within(sheet).getByText(/Replaces the open code for Sam\./)).toBeTruthy();
    expect(within(sheet).getByText(/stops working once an admin's device has seen the change/)).toBeTruthy();
    fireEvent.change(name, { target: { value: 'Samuel' } });
    expect(within(sheet).queryByText(/Replaces/)).toBeNull();
  });

  it('warns when the earlier code stayed open, and when this Mac couldn’t keep the new one', async () => {
    createInvite.mockResolvedValue({ success: true, state: admin, invite: { id: mine, code: CODE, expires: Date.now() + 86_400_000, kept: false, stillOpen: 1 } });
    const sheet = await openSheet(stateWith({ inviteCodeIds: [] }, []));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create code' }));
    expect(await within(sheet).findByText(/couldn’t keep the code/)).toBeTruthy();
    expect(within(sheet).getByText(/earlier code for this name is still open/)).toBeTruthy();
  });

  it('puts a kept code back behind Show when the sheet closes', async () => {
    createInvite.mockResolvedValue({ success: true, state: admin, invite: { id: theirs, code: 'fresh-code', expires: Date.now() + 86_400_000, kept: true, stillOpen: 0 } });
    const sheet = await openSheet(stateWith({ inviteCodeIds: [mine], inviteLabels: { [mine]: 'Sam' } }, [mine, theirs]));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create code' }));
    await within(sheet).findByLabelText('Invite code');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    const reopened = screen.getByRole('dialog', { name: 'Invite to Garden club' });
    expect(within(reopened).queryByLabelText('Invite code')).toBeNull();
  });
});
