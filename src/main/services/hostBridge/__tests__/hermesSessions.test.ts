import { describe, expect, it } from 'vitest';
import { LiveHermesSessions } from '../hermesSessions';

function sessions(idleMs = 35_000) {
  let now = 0;
  const live = new LiveHermesSessions(idleMs, () => now);
  return { live, advance: (ms: number) => (now += ms) };
}

describe('LiveHermesSessions', () => {
  it('counts a session once it has listed the tools', () => {
    const { live } = sessions();
    expect(live.seen('initialize', 'a')).toBe(false);
    expect(live.count).toBe(0);
    expect(live.seen('tools/list', 'a')).toBe(true);
    expect(live.seen('tools/list', 'a')).toBe(false);
    expect(live.count).toBe(1);
  });

  it('counts one Hermes process that re-initializes as one client, not one per session', () => {
    const { live, advance } = sessions();
    live.seen('tools/list', 'first');
    // The old session closes its HTTP session…
    expect(live.closed('first')).toBe(true);
    live.seen('tools/list', 'second');
    expect(live.count).toBe(1);
    // …or goes quiet and expires, while the new one keeps pinging.
    advance(20_000);
    live.seen('tools/list', 'third');
    advance(20_000);
    live.seen('ping', 'third');
    advance(20_000);
    expect(live.sweep()).toBe(true);
    expect(live.count).toBe(1);
  });

  it('keeps a session that pings every keepalive', () => {
    const { live, advance } = sessions();
    live.seen('tools/list', 'a');
    for (let i = 0; i < 10; i++) {
      advance(15_000);
      live.seen('ping', 'a');
      expect(live.sweep()).toBe(false);
    }
    expect(live.count).toBe(1);
  });

  it('ignores a close for a session it never counted', () => {
    const { live } = sessions();
    expect(live.closed('unknown')).toBe(false);
  });
});
