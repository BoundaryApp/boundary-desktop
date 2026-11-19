import { describe, expect, it, vi } from 'vitest';

vi.mock('../persistDebugLog', () => ({ persistDebugLog: vi.fn() }));

import { notificationChoice, RingAlerts, type RingAlertDeps } from '../callRingAlerts';
import { parseRingAlerts, type RingAlert } from '../../shared/calls/ringAlert';

const SAM: RingAlert = { room: 'person/0123456789abcdef', title: 'Sam is calling', body: 'Book club · just you two' };
const LEE: RingAlert = { room: 'person/1111111111111111', title: 'Lee is calling', body: 'Book club · just you two' };

function setup(front = false) {
  const state = { front };
  const shown: Array<{ ring: RingAlert; answer(): void; decline(): void; closed: number }> = [];
  const deps: RingAlertDeps = {
    inFront: () => state.front,
    notify: vi.fn((ring, on) => {
      const notice = { ring, ...on, closed: 0 };
      shown.push(notice);
      return {
        close: (): void => {
          notice.closed++;
        },
      };
    }),
    bounce: vi.fn(),
    stopBounce: vi.fn(),
    sound: vi.fn(),
    act: vi.fn(),
    log: vi.fn(),
  };
  return { state, shown, deps, alerts: new RingAlerts(deps) };
}

describe('RingAlerts', () => {
  it('does nothing new while the window is in front', () => {
    const { deps, alerts } = setup(true);
    alerts.setRings([SAM]);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.sound).not.toHaveBeenCalled();
    expect(deps.bounce).not.toHaveBeenCalled();
  });

  it('notifies once per ring, sounds and bounces while the window is not in front', () => {
    const { deps, alerts, shown } = setup();
    alerts.setRings([SAM]);
    expect(shown.map((notice) => notice.ring)).toEqual([SAM]);
    expect(deps.sound).toHaveBeenLastCalledWith(true);
    expect(deps.bounce).toHaveBeenCalledTimes(1);
    // The page sends the list again on every change; the same ring gets no second notice.
    alerts.setRings([SAM]);
    alerts.setRings([SAM, LEE]);
    expect(shown.map((notice) => notice.ring)).toEqual([SAM, LEE]);
    expect(deps.sound).toHaveBeenCalledTimes(1);
    expect(deps.bounce).toHaveBeenCalledTimes(1);
  });

  it('withdraws a ring’s notice when it ends, and stops once none is left', () => {
    const { deps, alerts, shown } = setup();
    alerts.setRings([SAM, LEE]);
    alerts.setRings([LEE]);
    expect(shown[0].closed).toBe(1);
    expect(shown[1].closed).toBe(0);
    expect(deps.sound).not.toHaveBeenCalledWith(false);
    alerts.setRings([]);
    expect(shown[1].closed).toBe(1);
    expect(deps.sound).toHaveBeenLastCalledWith(false);
    expect(deps.stopBounce).toHaveBeenCalledTimes(1);
  });

  it('stops and withdraws when the window comes to the front, and never notifies the same ring again', () => {
    const { state, deps, alerts, shown } = setup();
    alerts.setRings([SAM]);
    state.front = true;
    alerts.windowChanged();
    expect(shown[0].closed).toBe(1);
    expect(deps.sound).toHaveBeenLastCalledWith(false);
    expect(deps.stopBounce).toHaveBeenCalledTimes(1);

    state.front = false;
    alerts.windowChanged();
    expect(shown).toHaveLength(1);
    expect(deps.sound).toHaveBeenLastCalledWith(true);
    expect(deps.bounce).toHaveBeenCalledTimes(2);
  });

  it('starts alerting when the window leaves the front during a ring', () => {
    const { state, deps, alerts, shown } = setup(true);
    alerts.setRings([SAM]);
    state.front = false;
    alerts.windowChanged();
    expect(shown).toHaveLength(1);
    expect(deps.sound).toHaveBeenLastCalledWith(true);
  });

  it('passes Answer and Decline to the page, and does not close a notice the user already acted on', () => {
    const { deps, alerts, shown } = setup();
    alerts.setRings([SAM, LEE]);
    shown[0].answer();
    shown[1].decline();
    expect(deps.act).toHaveBeenNthCalledWith(1, { room: SAM.room, action: 'answer' });
    expect(deps.act).toHaveBeenNthCalledWith(2, { room: LEE.room, action: 'decline' });
    alerts.setRings([]);
    expect(shown.map((notice) => notice.closed)).toEqual([0, 0]);
  });

  it('works on when the system shows no notifications', () => {
    const { deps, alerts } = setup();
    vi.mocked(deps.notify).mockReturnValue(null);
    alerts.setRings([SAM]);
    expect(deps.sound).toHaveBeenLastCalledWith(true);
    expect(() => alerts.setRings([])).not.toThrow();
    expect(deps.sound).toHaveBeenLastCalledWith(false);
  });

  it('logs counts and states, never rooms or names', () => {
    const { deps, alerts } = setup();
    alerts.setRings([SAM]);
    alerts.setRings([]);
    const logged = JSON.stringify(vi.mocked(deps.log).mock.calls);
    expect(logged).not.toContain('person/');
    expect(logged).not.toContain('Sam');
    expect(logged).not.toContain('Book club');
  });
});

describe('notificationChoice', () => {
  it('reads the button from the event, or from the deprecated second argument', () => {
    expect(notificationChoice({ actionIndex: 0 }, undefined)).toBe('answer');
    expect(notificationChoice({ actionIndex: 1 }, 0)).toBe('decline');
    expect(notificationChoice({}, 0)).toBe('answer');
    expect(notificationChoice(undefined, 1)).toBe('decline');
    expect(notificationChoice({ actionIndex: 2 }, 2)).toBeNull();
  });
});

describe('parseRingAlerts', () => {
  it('takes a list of rings and keeps the first of a room', () => {
    expect(parseRingAlerts([SAM, LEE, { ...SAM, title: 'Again' }])).toEqual([SAM, LEE]);
    expect(parseRingAlerts([])).toEqual([]);
  });

  it('cuts long text and drops bad items rather than refusing the list', () => {
    const long = parseRingAlerts([{ ...SAM, title: 'x'.repeat(250) }, null, { ...LEE, body: 3 }, { ...LEE, title: '' }, LEE]);
    expect(long).toEqual([{ ...SAM, title: `${'x'.repeat(199)}…` }, LEE]);
    expect(parseRingAlerts(Array.from({ length: 20 }, (_, i) => ({ ...SAM, room: `person/${i}` })))).toHaveLength(16);
    expect(parseRingAlerts([{ ...SAM, room: 'p'.repeat(65) }])).toEqual([]);
  });

  it('refuses anything but a list', () => {
    expect(parseRingAlerts(null)).toBeNull();
    expect(parseRingAlerts({ ...SAM })).toBeNull();
  });
});
