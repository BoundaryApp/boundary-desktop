import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CircleOfferView, CirclesState } from '../../../../shared/types/circles';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { ProductReadyShell } from '../../ProductReadyShell';
import { OFFER_ALERT_MS, OFFER_QUIET_MS, OFFER_SETTLE_MS } from '../CircleOfferAlerts';

vi.mock('../../chat/WorkbenchChatScreen', () => ({ WorkbenchChatScreen: () => <div>chat-screen</div> }));

const push = vi.hoisted(() => ({ current: null as ((state: CirclesState) => void) | null }));

const offer = (overrides: Partial<CircleOfferView> = {}): CircleOfferView => ({
  identity: 'b'.repeat(64),
  name: 'Bo',
  isMine: false,
  models: [{ id: 'qwen', tools: true }],
  available: true,
  away: false,
  online: true,
  ...overrides,
});

const state = (offers: CircleOfferView[], overrides: Partial<CirclesState> = {}): CirclesState => ({
  status: 'running',
  displayName: 'Ada',
  snapshot: {
    identity: 'a'.repeat(64),
    circles: [{ key: 'c'.repeat(64), name: 'Garden club', myRole: 'member', writable: true, members: [], invites: [], offers }],
  },
  providers: {},
  sharing: { models: [], circles: [], paused: false, away: false },
  ...overrides,
});

const send = (next: CirclesState) => act(() => push.current?.(next));
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const toasts = () => screen.queryAllByRole('status').map((toast) => toast.textContent);

/** The shell mounted, with `offers` as the settled starting point. */
function mountSettled(offers: CircleOfferView[], onNavigate = vi.fn()) {
  render(<ProductReadyShell view="chat" onNavigate={onNavigate} />);
  send(state(offers));
  wait(OFFER_QUIET_MS);
}

describe('Circle offer alerts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubElectronAPI({
      circles: {
        getState: () => new Promise(() => undefined),
        onState: (cb: (next: CirclesState) => void) => {
          push.current = cb;
          return () => undefined;
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('toasts when a member first shares a model, on any screen', () => {
    mountSettled([]);
    send(state([offer()]));
    wait(OFFER_SETTLE_MS);
    expect(screen.getByText('chat-screen')).toBeTruthy();
    expect(toasts()[0]).toContain('Bo shared qwen with Garden club. You can use it now.');
  });

  it('toasts pause and resume', () => {
    mountSettled([offer()]);
    send(state([offer({ available: false })]));
    wait(OFFER_SETTLE_MS);
    expect(toasts()[0]).toContain("Bo paused qwen in Garden club. You can't use it until Bo resumes.");
    send(state([offer()]));
    wait(OFFER_SETTLE_MS);
    expect(toasts()[0]).toContain('Bo resumed qwen in Garden club. You can use it again.');
  });

  it('toasts offline and back once each has held', () => {
    mountSettled([offer()]);
    send(state([offer({ online: false })]));
    wait(OFFER_SETTLE_MS);
    expect(toasts()[0]).toContain("Bo went offline. You can't use qwen from Garden club until Bo is back.");
    send(state([offer()]));
    wait(OFFER_SETTLE_MS);
    expect(toasts()[0]).toContain('Bo is back online. You can use qwen from Garden club again.');
  });

  it('toasts when sharing stops', () => {
    mountSettled([offer()]);
    send(state([]));
    wait(OFFER_SETTLE_MS);
    expect(toasts()[0]).toContain("Bo stopped sharing qwen with Garden club. You can't use it now.");
  });

  it('stays quiet at start-up while offers load and providers connect', () => {
    render(<ProductReadyShell view="chat" onNavigate={vi.fn()} />);
    send(state([], { status: 'stopped' }));
    send(state([offer({ online: false }), offer({ identity: 'd'.repeat(64), name: 'Cy', online: false })]));
    wait(5_000);
    send(state([offer(), offer({ identity: 'd'.repeat(64), name: 'Cy', online: false })]));
    wait(5_000);
    send(state([offer(), offer({ identity: 'd'.repeat(64), name: 'Cy' })]));
    wait(OFFER_QUIET_MS + OFFER_SETTLE_MS);
    expect(toasts()).toEqual([]);
  });

  it('stays quiet about a Circle just joined, then reports it', () => {
    mountSettled([]);
    const joining = state([]);
    const garden = joining.snapshot.circles[0];
    const workshop = { ...garden, key: 'e'.repeat(64), name: 'Workshop' };
    const both = (offers: CircleOfferView[], myRole: 'member' | null) => ({
      ...joining,
      snapshot: { ...joining.snapshot, circles: [garden, { ...workshop, myRole, offers }] },
    });
    send(both([], null));
    wait(1_000);
    send(both([], 'member'));
    send(both([offer()], 'member'));
    wait(OFFER_QUIET_MS);
    expect(toasts()).toEqual([]);
    send(both([offer({ available: false })], 'member'));
    wait(OFFER_SETTLE_MS);
    expect(toasts()[0]).toContain('Bo paused qwen in Workshop.');
  });

  it('restarts the baseline after Circles stop', () => {
    mountSettled([offer()]);
    send(state([offer()], { status: 'stopped' }));
    send(state([offer({ online: false })]));
    wait(5_000);
    send(state([offer()]));
    wait(OFFER_QUIET_MS);
    expect(toasts()).toEqual([]);
  });

  it('stays silent through a brief drop', () => {
    mountSettled([offer()]);
    send(state([offer({ online: false })]));
    wait(OFFER_SETTLE_MS - 1);
    send(state([offer()]));
    wait(OFFER_SETTLE_MS * 2);
    expect(toasts()).toEqual([]);
  });

  it('waits for a flapping provider to hold still', () => {
    mountSettled([offer()]);
    send(state([offer({ online: false })]));
    wait(OFFER_SETTLE_MS - 1);
    send(state([offer()]));
    send(state([offer({ online: false })]));
    wait(OFFER_SETTLE_MS - 1);
    expect(toasts()).toEqual([]);
    wait(1);
    expect(toasts()).toHaveLength(1);
  });

  it("doesn't restart the settle period for an unrelated state push", () => {
    mountSettled([offer()]);
    send(state([offer({ online: false })]));
    wait(OFFER_SETTLE_MS - 1);
    send(state([offer({ online: false })], { displayName: 'Ada L' }));
    wait(1);
    expect(toasts()).toHaveLength(1);
  });

  it("never toasts about the user's own offer", () => {
    const mine = offer({ identity: 'a'.repeat(64), name: 'Ada', isMine: true });
    mountSettled([mine]);
    send(state([{ ...mine, available: false }]));
    wait(OFFER_SETTLE_MS);
    send(state([]));
    wait(OFFER_SETTLE_MS);
    send(state([mine]));
    wait(OFFER_SETTLE_MS);
    expect(toasts()).toEqual([]);
  });

  it('collapses changes that land together from one provider', () => {
    mountSettled([offer()]);
    send(state([offer({ models: [{ id: 'qwen', tools: true }, { id: 'llama', tools: false }] })]));
    wait(1_000);
    send(state([offer({ models: [{ id: 'llama', tools: false }] })]));
    wait(OFFER_SETTLE_MS);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toContain('Bo shared llama with Garden club.');
    expect(toasts()[0]).toContain('Bo stopped sharing qwen with Garden club.');
  });

  it('opens the Circles screen, dismisses and expires', () => {
    const onNavigate = vi.fn();
    mountSettled([], onNavigate);
    send(state([offer()]));
    wait(OFFER_SETTLE_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Open Circles' }));
    expect(onNavigate).toHaveBeenCalledWith('circles');
    expect(toasts()).toEqual([]);

    send(state([offer({ available: false })]));
    wait(OFFER_SETTLE_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(toasts()).toEqual([]);

    send(state([offer()]));
    wait(OFFER_SETTLE_MS);
    expect(toasts()).toHaveLength(1);
    wait(OFFER_ALERT_MS);
    expect(toasts()).toEqual([]);
  });
});
