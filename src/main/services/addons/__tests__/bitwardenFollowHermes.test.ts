import { describe, expect, it, vi } from 'vitest';
import type { PlainOutcome } from '../addonScript';
import { createHermesFollower } from '../bitwardenFollowHermes';

const ok: PlainOutcome = { code: 0, stdout: '', stderrTail: [] };

function setup(overrides: { active?: boolean; run?: () => Promise<PlainOutcome> } = {}) {
  let t = 1000;
  const run = vi.fn(overrides.run ?? (async () => { t += 250; return ok; }));
  const refresh = vi.fn(async () => undefined);
  const log = vi.fn();
  const follower = createHermesFollower({ active: () => overrides.active ?? true, run, refresh, log, now: () => t });
  return { follower, run, refresh, log };
}

describe('createHermesFollower', () => {
  it('does nothing while Bitwarden is off', async () => {
    const { follower, run, refresh } = setup({ active: false });
    await follower.follow('start');
    expect(run).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('runs follow-hermes, then refreshes', async () => {
    const { follower, run, refresh, log } = setup();
    await follower.follow('settings-restart');
    expect(run).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
    expect(log).toHaveBeenCalledWith('follow-hermes', { reason: 'settings-restart', code: 0, ms: 250 });
  });

  it('coalesces overlapping calls', async () => {
    const resolvers: Array<() => void> = [];
    const { follower, run } = setup({ run: () => new Promise<PlainOutcome>((resolve) => resolvers.push(() => resolve(ok))) });
    const calls = [follower.follow('start'), follower.follow('web-search'), follower.follow('addon-reload')];
    expect(run).toHaveBeenCalledTimes(1);
    resolvers[0]();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    resolvers[1]();
    await Promise.all(calls);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('never runs two at once, even in the microtask between a run ending and the queued one starting', async () => {
    const resolvers: Array<() => void> = [];
    let running = 0;
    let most = 0;
    let auto = false;
    const { follower } = setup({
      run: () => {
        running += 1;
        most = Math.max(most, running);
        return new Promise<PlainOutcome>((resolve) => {
          const finish = () => {
            running -= 1;
            resolve(ok);
          };
          if (auto) queueMicrotask(finish);
          else resolvers.push(finish);
        });
      },
    });
    const calls = [follower.follow('start'), follower.follow('web-search')];
    resolvers.shift()?.();
    // A call on each microtask while the first run finishes and the queued one starts.
    for (let i = 0; i < 20; i += 1) {
      calls.push(follower.follow('addon-reload'));
      await Promise.resolve();
    }
    expect(most).toBe(1);
    auto = true;
    for (const finish of resolvers.splice(0)) finish();
    await Promise.all(calls);
    expect(most).toBe(1);
  });

  it('never throws when the script exits non-zero', async () => {
    const { follower, refresh, log } = setup({ run: async () => ({ code: 1, stdout: 'secret', stderrTail: ['secret'] }) });
    await expect(follower.follow('start')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('follow-hermes', expect.objectContaining({ code: 1 }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('never throws when the script rejects', async () => {
    const { follower, refresh, log } = setup({ run: async () => { throw new TypeError('boom'); } });
    await expect(follower.follow('start')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('follow-hermes', expect.objectContaining({ error: 'TypeError' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
