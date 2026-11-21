import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JoinOptions } from '../callService';
import { inCallOrJoining, useCallEntry, type CallEntryOptions } from '../useCallEntry';

const service = vi.hoisted(() => ({ current: null as object | null, joining: false }));
vi.mock('../callService', () => ({ getCallService: () => service }));
const opened = vi.hoisted(() => [] as Array<Promise<unknown>>);
vi.mock('../callViewState', () => ({ openCallViewOnJoin: (joining: Promise<unknown>) => opened.push(joining) }));
vi.mock('../LeaveCallSheet', () => ({
  LeaveCallSheet: ({ open, then, onLeave, onCancel }: { open: boolean; then: string; onLeave: () => void; onCancel: () => void }) =>
    open ? (
      <div role="dialog" aria-label="Leave">
        <button onClick={onLeave}>{then === 'call' ? 'Leave and call' : 'Leave and join'}</button>
        <button onClick={onCancel}>Stay</button>
      </div>
    ) : null,
}));
vi.mock('../JoinCallSheet', () => ({
  JoinCallSheet: ({ title, onJoin, onCancel }: { title: string; onJoin: (options: JoinOptions) => void; onCancel: () => void }) => (
    <div role="dialog" aria-label={title}>
      <button onClick={() => onJoin({ audio: true, video: false })}>Join</button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

type Target = { id: string };

function Harness(props: Partial<CallEntryOptions<Target>> & { target?: Target }) {
  const { target = { id: 'a' }, ...options } = props;
  const { enter, sheets } = useCallEntry<Target>({
    then: 'call',
    title: (item) => `Call ${item.id}`,
    join: async () => ({}) as never,
    ...options,
  });
  return (
    <>
      <button onClick={() => enter(target)}>Call</button>
      {sheets}
    </>
  );
}

beforeEach(() => {
  service.current = null;
  service.joining = false;
  opened.length = 0;
});
afterEach(cleanup);

describe('inCallOrJoining', () => {
  it('counts a call that is on and a join still opening its devices', () => {
    expect(inCallOrJoining({ current: null, joining: false })).toBe(false);
    expect(inCallOrJoining({ current: {} as never, joining: false })).toBe(true);
    expect(inCallOrJoining({ current: null, joining: true })).toBe(true);
  });
});

describe('useCallEntry', () => {
  it('opens the join sheet straight away with no call', () => {
    const onAsk = vi.fn();
    render(<Harness onAsk={onAsk} />);
    fireEvent.click(screen.getByText('Call'));
    expect(screen.getByRole('dialog', { name: 'Call a' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Leave' })).toBeNull();
    expect(onAsk).toHaveBeenCalledWith({ id: 'a' });
  });

  it('asks before leaving a call that is on', () => {
    service.current = {};
    render(<Harness />);
    fireEvent.click(screen.getByText('Call'));
    expect(screen.getByRole('dialog', { name: 'Leave' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Call a' })).toBeNull();
  });

  it('asks before leaving while another join is still opening its devices', () => {
    service.joining = true;
    render(<Harness />);
    fireEvent.click(screen.getByText('Call'));
    expect(screen.getByRole('dialog', { name: 'Leave' })).toBeTruthy();
  });

  it('shows the join sheet after leaving, and joining opens the call view', () => {
    service.current = {};
    const onAsk = vi.fn();
    const join = vi.fn(async () => ({}) as never);
    render(<Harness onAsk={onAsk} join={join} />);
    fireEvent.click(screen.getByText('Call'));
    fireEvent.click(screen.getByText('Leave and call'));
    expect(screen.queryByRole('dialog', { name: 'Leave' })).toBeNull();
    expect(onAsk).toHaveBeenCalledWith({ id: 'a' });
    fireEvent.click(screen.getByText('Join'));
    expect(join).toHaveBeenCalledWith({ id: 'a' }, { audio: true, video: false });
    expect(opened).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'Call a' })).toBeNull();
  });

  it('staying in the call opens nothing', () => {
    service.current = {};
    const onAsk = vi.fn();
    render(<Harness onAsk={onAsk} />);
    fireEvent.click(screen.getByText('Call'));
    fireEvent.click(screen.getByText('Stay'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onAsk).not.toHaveBeenCalled();
  });

  it('cancelling the join sheet tells the caller', () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Call'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledWith({ id: 'a' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes a sheet whose target is gone', () => {
    let live = true;
    service.current = {};
    const view = render(<Harness liveForLeave={(item) => (live ? item : null)} />);
    fireEvent.click(screen.getByText('Call'));
    expect(screen.getByRole('dialog', { name: 'Leave' })).toBeTruthy();
    live = false;
    view.rerender(<Harness liveForLeave={(item) => (live ? item : null)} />);
    expect(screen.queryByRole('dialog', { name: 'Leave' })).toBeNull();

    service.current = null;
    live = true;
    view.rerender(<Harness liveForJoin={(item) => (live ? item : null)} />);
    fireEvent.click(screen.getByText('Call'));
    expect(screen.getByRole('dialog', { name: 'Call a' })).toBeTruthy();
    live = false;
    view.rerender(<Harness liveForJoin={(item) => (live ? item : null)} />);
    expect(screen.queryByRole('dialog', { name: 'Call a' })).toBeNull();
  });
});
