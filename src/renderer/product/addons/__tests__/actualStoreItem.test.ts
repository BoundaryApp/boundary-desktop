import { describe, expect, it } from 'vitest';
import type { ActualBudget, ActualOverview } from '../../../../shared/types/addons';
import { addonStoreItem, isInstalled, onServicesHome } from '../storeItems';
import { actualListing } from './addonFixtures';

const row = (extra: Partial<ActualBudget>): ActualBudget => ({
  slug: 'home',
  server: 'https://budget.example.com',
  local: false,
  syncId: 's',
  access: 'read',
  state: 'ok',
  ...extra,
});
const overview = (budgets: ActualBudget[], localSetUp = false): ActualOverview => ({
  enabled: true,
  local: false,
  localSetUp,
  budgets,
  statusError: null,
});

describe('Actual’s store card', () => {
  it('offers Get before anything is set up', () => {
    const item = addonStoreItem(actualListing(), null, null, overview([]));
    expect(item).toMatchObject({ category: 'money', state: { kind: 'get' }, attention: false });
  });

  it('is on, with nothing to open, when only another server’s budget is connected', () => {
    // The budget's MCP containers run here, so unlike a hosted Twenty it counts as installed.
    const item = addonStoreItem(actualListing(), null, null, overview([row({})]));
    expect(item.state).toEqual({ kind: 'on', canOpen: false });
    expect(isInstalled(item.state)).toBe(true);
  });

  it('is Connected when Actual is off but another server’s budget is still recorded', () => {
    const item = addonStoreItem(actualListing(), null, null, { ...overview([row({})]), enabled: false });
    expect(item.state).toEqual({ kind: 'view', line: 'Connected', tone: 'ok', ours: true });
    expect(isInstalled(item.state)).toBe(false);
    expect(onServicesHome(item)).toBe(true);
  });

  it('offers Turn on while this Mac’s server is set up but off', () => {
    expect(addonStoreItem(actualListing(), null, null, overview([], true)).state).toEqual({ kind: 'off-data' });
  });

  it('flags a budget whose sign-in stopped working, but not one on a server turned off on purpose', () => {
    expect(addonStoreItem(actualListing(true), null, null, overview([row({ state: 'token_expired' })])).attention).toBe(true);
    expect(addonStoreItem(actualListing(), null, null, overview([row({ local: true, state: 'server_off' })])).attention).toBe(false);
  });
});
