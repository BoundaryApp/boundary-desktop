import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsNewService, type WhatsNewStore, type WhatsNewStoreShape } from '../WhatsNewService';

const CURRENT = '0.0.1-rc.11';

/** A store that outlives a service, so a second launch reads what the first wrote. */
function fakeStore(initial: Partial<WhatsNewStoreShape> = {}): WhatsNewStore {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (key) => values.get(key) as never,
    set: (key, value) => void values.set(key, value),
  };
}

describe('WhatsNewService', () => {
  let closeUpdated: () => void;
  beforeEach(() => {
    closeUpdated = vi.fn<() => void>();
  });

  const build = (store: WhatsNewStore, setupComplete = true) =>
    new WhatsNewService({ currentVersion: CURRENT, setupComplete: () => setupComplete, store, closeUpdated });

  it('treats a fresh install with no setup as a first install', () => {
    const snapshot = build(fakeStore(), false).snapshot();
    expect(snapshot.firstInstall).toBe(true);
    expect(snapshot.upgradedFrom).toBeNull();
    expect(snapshot.seen).toContain(CURRENT);
  });

  it('treats a fresh store with setup complete as an upgrade from unknown', () => {
    expect(build(fakeStore()).snapshot().upgradedFrom).toBe('unknown');
  });

  it('reports the earlier version when one was recorded', () => {
    expect(build(fakeStore({ lastRunVersion: '0.0.1-rc.9' })).snapshot().upgradedFrom).toBe('0.0.1-rc.9');
  });

  it('keeps the upgrade pending when a launch ends before it is seen', () => {
    const store = fakeStore({ lastRunVersion: '0.0.1-rc.9' });
    build(store);
    expect(build(store).snapshot().upgradedFrom).toBe('0.0.1-rc.9');
  });

  it('still reports where the install came from once the notes are read', () => {
    const service = build(fakeStore({ lastRunVersion: '0.0.1-rc.9' }));
    service.markSeen(CURRENT);
    expect(service.snapshot().upgradedFrom).toBe('0.0.1-rc.9');
  });

  it('keeps the older upgrade when a version’s notes were never read', () => {
    const store = fakeStore({ lastRunVersion: '0.0.1-rc.9' });
    build(store); // rc.9 → rc.10, never read
    store.set('lastRunVersion', '0.0.1-rc.10');
    expect(build(store).snapshot().upgradedFrom).toBe('0.0.1-rc.9');
  });

  it('moves the upgrade on once the last version’s notes were read', () => {
    const store = fakeStore({ lastRunVersion: '0.0.1-rc.9' });
    const first = build(store);
    first.markSeen('0.0.1-rc.10');
    store.set('lastRunVersion', '0.0.1-rc.10');
    expect(build(store).snapshot().upgradedFrom).toBe('0.0.1-rc.10');
  });

  it('keeps the upgrade while only an earlier release is seen', () => {
    const service = build(fakeStore({ lastRunVersion: '0.0.1-rc.9' }));
    service.markSeen('0.0.1-rc.10');
    expect(service.snapshot().upgradedFrom).toBe('0.0.1-rc.9');
    expect(service.snapshot().seen).toContain('0.0.1-rc.10');
  });

  it('reports no upgrade when the stored version is newer than the current one', () => {
    expect(build(fakeStore({ lastRunVersion: '0.0.1-rc.14' })).snapshot().upgradedFrom).toBeNull();
  });

  it('reports no upgrade when the same version runs again', () => {
    expect(build(fakeStore({ lastRunVersion: CURRENT, seen: [CURRENT] })).snapshot().upgradedFrom).toBeNull();
  });

  it('remembers that popups are off', () => {
    const store = fakeStore({ lastRunVersion: '0.0.1-rc.9' });
    build(store).setPopups(false);
    expect(build(store).snapshot().popups).toBe(false);
  });

  it('has popups on until they are turned off', () => {
    expect(build(fakeStore()).snapshot().popups).toBe(true);
  });

  it('closes the update card when the current version is seen', () => {
    build(fakeStore({ lastRunVersion: '0.0.1-rc.9' })).markSeen(CURRENT);
    expect(closeUpdated).toHaveBeenCalled();
  });

  it('leaves the update card alone when an earlier release is seen', () => {
    build(fakeStore({ lastRunVersion: '0.0.1-rc.9' })).markSeen('0.0.1-rc.10');
    expect(closeUpdated).not.toHaveBeenCalled();
  });

  it('reports no upgrade for an install that has only ever run this version', () => {
    expect(build(fakeStore({ lastRunVersion: CURRENT, seen: [CURRENT] })).snapshot().upgradedFrom).toBeNull();
  });

  it('tells listeners when the state changes', () => {
    const changed = vi.fn();
    const service = new WhatsNewService({
      currentVersion: CURRENT,
      setupComplete: () => true,
      store: fakeStore({ lastRunVersion: '0.0.1-rc.9' }),
      closeUpdated,
      onChange: changed,
    });
    service.setPopups(false);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ popups: false }));
  });
});
