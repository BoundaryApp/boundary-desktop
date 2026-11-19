import { describe, expect, it, vi } from 'vitest';
import type { ServiceOfferRecord, ShareLevel } from '../../../../shared/serviceOffers';
import type { MemberKeys } from '../../addons/twentyMemberKeys';
import type { ServiceSharing } from '../networkMessages';
import { createSharedServices, memberKeyName, type GrantInput, type ServiceGrantsState, type SharedServicesDeps } from '../sharedServices';

const CIRCLE = 'c'.repeat(64);
const SERVICE = 'twenty.main';
const SAM = 's'.repeat(64);
const TESS = 't'.repeat(64);
const UPSTREAM = { mcpUrl: 'http://127.0.0.1:3000/mcp' };

const OFFER: ServiceOfferRecord = { kind: 'twenty', name: 'Book club CRM', levels: ['read', 'write'], available: true, away: false };

function setup(overrides: Partial<SharedServicesDeps> = {}) {
  let state: ServiceGrantsState = { grants: [], revoke: [] };
  let minted = 0;
  const pushed: ServiceSharing[] = [];
  const revoked: string[][] = [];
  const offers: Array<[string, string, ServiceOfferRecord | null]> = [];
  const log = vi.fn();
  const mintKeys = vi.fn(async (_name: string, level: ShareLevel): Promise<MemberKeys> => {
    const key = () => {
      const id = `key-${++minted}`;
      return { id, token: `token-${id}` };
    };
    const read = key();
    return level === 'write' ? { read, write: key() } : { read };
  });
  const deps: SharedServicesDeps = {
    load: async () => structuredClone(state),
    save: async (next) => {
      state = structuredClone(next);
    },
    mintKeys,
    revokeKeys: async (ids) => void revoked.push(ids),
    upstreamFor: (service) => (service === SERVICE ? UPSTREAM : null),
    setOffer: async (circle, service, offer) => void offers.push([circle, service, offer]),
    deleteOffer: async (circle, service) => void offers.push([circle, service, null]),
    push: async (sharing) => void pushed.push(sharing),
    log,
    ...overrides,
  };
  return { services: createSharedServices(deps), state: () => state, pushed, revoked, offers, mintKeys, log };
}

const grant = (overrides: Partial<GrantInput> = {}): GrantInput => ({
  circle: CIRCLE,
  service: SERVICE,
  identity: SAM,
  memberName: 'Sam',
  circleName: 'Book club',
  level: 'read',
  ...overrides,
});

describe('memberKeyName', () => {
  it('names the member and Circle', () => {
    expect(memberKeyName('  Sam  Lee ', 'Book club')).toBe('Sam Lee · Book club');
    expect(memberKeyName('', '')).toBe('Member · Circle');
    expect(memberKeyName('x'.repeat(200), 'Book club')).toHaveLength(100);
  });
});

describe('createSharedServices', () => {
  it('grants read access with keys named for the member and Circle, and hands the gateway the tokens', async () => {
    const t = setup();
    await t.services.grant(grant());

    expect(t.mintKeys).toHaveBeenCalledWith('Sam · Book club', 'read');
    expect(t.state().grants).toEqual([
      { circle: CIRCLE, service: SERVICE, identity: SAM, level: 'read', read: { id: 'key-1', token: 'token-key-1' } },
    ]);
    expect(t.pushed.at(-1)).toEqual({
      upstreams: { [SERVICE]: UPSTREAM },
      grants: [{ circle: CIRCLE, service: SERVICE, identity: SAM, read: 'token-key-1' }],
    });
  });

  it('does nothing when the member already has that level', async () => {
    const t = setup();
    await t.services.grant(grant());
    await t.services.grant(grant());
    expect(t.mintKeys).toHaveBeenCalledTimes(1);
  });

  it('raises read to write with new keys and revokes the old read key after the gateway has the new ones', async () => {
    const t = setup();
    await t.services.grant(grant());
    await t.services.grant(grant({ level: 'write' }));

    expect(t.state().grants).toEqual([
      expect.objectContaining({ level: 'write', read: { id: 'key-2', token: 'token-key-2' }, write: { id: 'key-3', token: 'token-key-3' } }),
    ]);
    expect(t.pushed.at(-1)!.grants[0]).toMatchObject({ read: 'token-key-2', write: 'token-key-3' });
    expect(t.revoked).toEqual([['key-1']]);
  });

  it('lowers write to read by revoking only the write key', async () => {
    const t = setup();
    await t.services.grant(grant({ level: 'write' }));
    await t.services.grant(grant({ level: 'read' }));

    expect(t.mintKeys).toHaveBeenCalledTimes(1);
    expect(t.state().grants).toEqual([expect.objectContaining({ level: 'read', read: { id: 'key-1', token: 'token-key-1' } })]);
    expect(t.state().grants[0]!.write).toBeUndefined();
    expect(t.revoked).toEqual([['key-2']]);
  });

  it('runs grants one at a time, so two at once both keep their keys', async () => {
    const t = setup();
    await Promise.all([t.services.grant(grant()), t.services.grant(grant({ identity: TESS, memberName: 'Tess' }))]);
    expect(t.state().grants.map((g) => g.identity).sort()).toEqual([SAM, TESS].sort());
  });

  it('revokes one member and leaves the others, refusing them at the gateway before revoking', async () => {
    const order: string[] = [];
    const t = setup({
      push: async (sharing) => void order.push(`push:${sharing.grants.length}`),
      revokeKeys: async (ids) => void order.push(`revoke:${ids.join(',')}`),
    });
    await t.services.grant(grant());
    await t.services.grant(grant({ identity: TESS, memberName: 'Tess', level: 'write' }));
    order.length = 0;

    await t.services.revoke(CIRCLE, SERVICE, TESS);
    expect(order).toEqual(['push:1', 'revoke:key-2,key-3']);
    expect(t.state().grants.map((g) => g.identity)).toEqual([SAM]);
  });

  it('keeps a revoke that fails and retries it on the next sync', async () => {
    let fail = true;
    const revoked: string[][] = [];
    const t = setup({
      revokeKeys: async (ids) => {
        if (fail) throw Object.assign(new Error('Twenty isn’t answering.'), { reason: 'down' });
        revoked.push(ids);
      },
    });
    await t.services.grant(grant({ level: 'write' }));
    await t.services.revoke(CIRCLE, SERVICE, SAM);

    expect(t.state()).toEqual({ grants: [], revoke: ['key-1', 'key-2'] });
    expect(t.log).toHaveBeenCalledWith('shared service revoke deferred', { keys: 2, reason: 'down' });

    await t.services.sync();
    expect(t.state().revoke).toEqual(['key-1', 'key-2']);

    fail = false;
    await t.services.sync();
    expect(revoked).toEqual([['key-1', 'key-2']]);
    expect(t.state().revoke).toEqual([]);
  });

  it('revokes keys it minted but couldn’t keep', async () => {
    const t = setup({
      save: async () => {
        throw new Error('The keychain isn’t available.');
      },
    });
    await expect(t.services.grant(grant({ level: 'write' }))).rejects.toThrow('keychain');
    expect(t.revoked).toEqual([['key-1', 'key-2']]);
    expect(t.pushed).toHaveLength(0);
  });

  it('writes a checked offer, and narrowing it to read takes write keys away', async () => {
    const t = setup();
    await t.services.offer(CIRCLE, SERVICE, { ...OFFER, name: ' Book club CRM ' });
    expect(t.offers.at(-1)).toEqual([CIRCLE, SERVICE, OFFER]);
    await t.services.grant(grant({ level: 'write' }));
    await t.services.grant(grant({ identity: TESS, memberName: 'Tess' }));

    await t.services.offer(CIRCLE, SERVICE, { ...OFFER, levels: ['read'] });
    expect(t.state().grants.map((g) => [g.identity, g.level, Boolean(g.write)])).toEqual([
      [SAM, 'read', false],
      [TESS, 'read', false],
    ]);
    expect(t.revoked).toEqual([['key-2']]);
    expect(t.pushed.at(-1)!.grants.every((g) => !g.write)).toBe(true);
  });

  it('refuses an offer this build can’t share, before writing it', async () => {
    const t = setup();
    await expect(t.services.offer(CIRCLE, SERVICE, { ...OFFER, levels: [] })).rejects.toThrow();
    expect(t.offers).toHaveLength(0);
  });

  it('withdraws an offer and every grant for it, in that Circle only', async () => {
    const other = 'd'.repeat(64);
    const t = setup();
    await t.services.grant(grant());
    await t.services.grant(grant({ circle: other }));
    await t.services.withdraw(CIRCLE, SERVICE);

    expect(t.offers.at(-1)).toEqual([CIRCLE, SERVICE, null]);
    expect(t.state().grants.map((g) => g.circle)).toEqual([other]);
    expect(t.revoked).toEqual([['key-1']]);
  });

  it('leaves out an upstream it can’t reach but still sends the grants', async () => {
    const t = setup({ upstreamFor: () => null });
    await t.services.grant(grant());
    expect(t.pushed.at(-1)).toMatchObject({ upstreams: {}, grants: [expect.objectContaining({ identity: SAM })] });
  });

  it('lists levels without keys', async () => {
    const t = setup();
    await t.services.grant(grant({ level: 'write' }));
    expect(await t.services.levels(CIRCLE, SERVICE)).toEqual([{ identity: SAM, level: 'write' }]);
  });

  it('never logs a token', async () => {
    const t = setup();
    await t.services.grant(grant({ level: 'write' }));
    await t.services.revoke(CIRCLE, SERVICE, SAM);
    expect(JSON.stringify(t.log.mock.calls)).not.toContain('token-');
  });
});
