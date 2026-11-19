/**
 * The provider's side of shared services in main (ADR 0048 §2, §4, §9): offers written to a
 * Circle's records, and the grants behind them. Each grant holds one member's Twenty keys, kept
 * encrypted on this Mac and handed to the network process's gateway in memory. Keys never go to a
 * Circle's log or to the renderer.
 *
 * Changes run one at a time, so two grants made together can't lose each other's keys. Taking
 * access away stops the gateway first and revokes the keys in Twenty after; a revoke that fails
 * is kept and tried again on the next sync.
 */
import { parseServiceOffer, type ServiceOfferRecord, type ShareLevel } from '../../../shared/serviceOffers';
import { createSerialQueue } from '../../../shared/utils/serialQueue';
import type { MemberKeys, MintedKey } from '../addons/twentyMemberKeys';
import type { ServiceGrantEntry, ServiceSharing } from './networkMessages';
import type { ServiceUpstream } from './serviceGateway';

/** One member's access to one service in one Circle, with the keys minted for it. */
export interface StoredServiceGrant {
  circle: string;
  service: string;
  identity: string;
  level: ShareLevel;
  read: MintedKey;
  write?: MintedKey;
}

/** What main keeps, encrypted. `revoke` holds key ids whose revoke hasn't gone through yet. */
export interface ServiceGrantsState {
  grants: StoredServiceGrant[];
  revoke: string[];
}

export interface SharedServicesDeps {
  load(): Promise<ServiceGrantsState>;
  save(state: ServiceGrantsState): Promise<void>;
  /** Mints keys named `name` (what Twenty shows as a record's creator). */
  mintKeys(name: string, level: ShareLevel): Promise<MemberKeys>;
  revokeKeys(ids: string[]): Promise<void>;
  /** Where the gateway reaches a service on this Mac, or null when it can't be served now. */
  upstreamFor(service: string): ServiceUpstream | null;
  setOffer(circle: string, service: string, offer: ServiceOfferRecord): Promise<void>;
  deleteOffer(circle: string, service: string): Promise<void>;
  /** Hands the gateway what it serves. Does nothing while Circles aren't running. */
  push(sharing: ServiceSharing): Promise<void>;
  /** Metadata only. */
  log(message: string, data?: Record<string, unknown>): void;
}

export interface GrantInput {
  circle: string;
  service: string;
  identity: string;
  /** For the key's name: `<member name> · <Circle name>` (spec decision 2). */
  memberName: string;
  circleName: string;
  level: ShareLevel;
}

const KEY_NAME_MAX = 100;

/** The service id of this Mac's own Twenty workspace, the one the stack runs (slug `main`). */
const LOCAL_TWENTY_SERVICE = 'twenty.main';

/** Where the gateway reaches a service on this Mac: only the local Twenty's MCP endpoint for now. */
export function localServiceUpstream(service: string, twentyPort: number | null): ServiceUpstream | null {
  if (service !== LOCAL_TWENTY_SERVICE || twentyPort === null) return null;
  return { mcpUrl: `http://127.0.0.1:${twentyPort}/mcp` };
}

const sameGrant = (grant: StoredServiceGrant, circle: string, service: string, identity?: string): boolean =>
  grant.circle === circle && grant.service === service && (identity === undefined || grant.identity === identity);

const keyIds = (grant: Pick<StoredServiceGrant, 'read' | 'write'>): string[] =>
  grant.write ? [grant.read.id, grant.write.id] : [grant.read.id];

/** The name a member's key carries in Twenty. */
export function memberKeyName(memberName: string, circleName: string): string {
  const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
  return `${clean(memberName) || 'Member'} · ${clean(circleName) || 'Circle'}`.slice(0, KEY_NAME_MAX);
}

/** What the gateway needs: an upstream for each granted service it can reach, and the keys. */
function sharingFor(grants: StoredServiceGrant[], upstreamFor: (service: string) => ServiceUpstream | null): ServiceSharing {
  const upstreams: Record<string, ServiceUpstream> = {};
  for (const service of new Set(grants.map((grant) => grant.service))) {
    const upstream = upstreamFor(service);
    if (upstream) upstreams[service] = upstream;
  }
  const entries: ServiceGrantEntry[] = grants.map((grant) => ({
    circle: grant.circle,
    service: grant.service,
    identity: grant.identity,
    read: grant.read.token,
    ...(grant.write ? { write: grant.write.token } : {}),
  }));
  return { upstreams, grants: entries };
}

export function createSharedServices(deps: SharedServicesDeps) {
  const serial = createSerialQueue();

  const push = (state: ServiceGrantsState) => deps.push(sharingFor(state.grants, deps.upstreamFor));

  /** Revokes `ids` in Twenty; any that fail are kept in `state.revoke` for the next sync. */
  async function revokeOrKeep(state: ServiceGrantsState, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await deps.revokeKeys(ids);
    } catch (error) {
      state.revoke = [...new Set([...state.revoke, ...ids])];
      await deps.save(state);
      deps.log('shared service revoke deferred', { keys: ids.length, reason: (error as { reason?: string }).reason ?? 'unknown' });
    }
  }

  /** Drops the grants `drop` picks: the gateway refuses them before their keys are revoked. */
  async function dropGrants(state: ServiceGrantsState, drop: (grant: StoredServiceGrant) => boolean): Promise<number> {
    const dropped = state.grants.filter(drop);
    if (dropped.length === 0) return 0;
    state.grants = state.grants.filter((grant) => !drop(grant));
    await deps.save(state);
    await push(state);
    await revokeOrKeep(state, dropped.flatMap(keyIds));
    return dropped.length;
  }

  return {
    /**
     * Publish or change an offer. Narrowing it to `read` takes each member's write key away
     * (ADR 0048 §9); their read keys stay.
     */
    offer: (circle: string, service: string, offer: ServiceOfferRecord): Promise<void> =>
      serial(async () => {
        const checked = parseServiceOffer(offer);
        if (!checked) throw new Error('That isn’t an offer this build can share.');
        await deps.setOffer(circle, service, checked);
        if (checked.levels.includes('write')) return;
        const state = await deps.load();
        const narrowed = state.grants.filter((grant) => sameGrant(grant, circle, service) && grant.write);
        if (narrowed.length === 0) return;
        const writeIds = narrowed.map((grant) => grant.write!.id);
        state.grants = state.grants.map((grant) =>
          narrowed.includes(grant) ? { ...grant, level: 'read' as const, write: undefined } : grant
        );
        await deps.save(state);
        await push(state);
        await revokeOrKeep(state, writeIds);
        deps.log('shared service narrowed', { service, circle: circle.slice(0, 8), grants: narrowed.length });
      }),

    /** Stop offering a service in a Circle and take every member's access to it away. */
    withdraw: (circle: string, service: string): Promise<void> =>
      serial(async () => {
        await deps.deleteOffer(circle, service);
        const dropped = await dropGrants(await deps.load(), (grant) => sameGrant(grant, circle, service));
        deps.log('shared service withdrawn', { service, circle: circle.slice(0, 8), grants: dropped });
      }),

    /**
     * Give a member access at `level`. A member who had access at the other level gets new keys,
     * and the old ones are revoked; at the same level nothing changes.
     */
    grant: (input: GrantInput): Promise<void> =>
      serial(async () => {
        const state = await deps.load();
        const existing = state.grants.find((grant) => sameGrant(grant, input.circle, input.service, input.identity));
        if (existing?.level === input.level) return;
        if (existing?.level === 'write' && input.level === 'read') {
          const writeId = existing.write?.id;
          state.grants = state.grants.map((grant) => (grant === existing ? { ...grant, level: 'read', write: undefined } : grant));
          await deps.save(state);
          await push(state);
          await revokeOrKeep(state, writeId ? [writeId] : []);
          return;
        }
        const keys = await deps.mintKeys(memberKeyName(input.memberName, input.circleName), input.level);
        const grant: StoredServiceGrant = {
          circle: input.circle,
          service: input.service,
          identity: input.identity,
          level: input.level,
          ...keys,
        };
        state.grants = [...state.grants.filter((other) => other !== existing), grant];
        try {
          await deps.save(state);
        } catch (error) {
          // Keys that can't be kept would be live in Twenty with no way to find them again.
          await deps.revokeKeys(keyIds(grant)).catch((): void => undefined);
          throw error;
        }
        await push(state);
        if (existing) await revokeOrKeep(state, keyIds(existing));
        deps.log('shared service granted', { service: input.service, circle: input.circle.slice(0, 8), level: input.level });
      }),

    /** Take one member's access away. */
    revoke: (circle: string, service: string, identity: string): Promise<void> =>
      serial(async () => {
        const dropped = await dropGrants(await deps.load(), (grant) => sameGrant(grant, circle, service, identity));
        deps.log('shared service revoked', { service, circle: circle.slice(0, 8), grants: dropped });
      }),

    /** The levels each member holds, without keys, for the provider's panel. */
    levels: (circle: string, service: string): Promise<Array<{ identity: string; level: ShareLevel }>> =>
      serial(async () =>
        (await deps.load()).grants
          .filter((grant) => sameGrant(grant, circle, service))
          .map((grant) => ({ identity: grant.identity, level: grant.level }))
      ),

    /**
     * Hand the gateway what it serves and retry revokes that failed. Run whenever Circles start;
     * a gateway that has just started holds no grants, so with none there is nothing to send.
     */
    sync: (): Promise<void> =>
      serial(async () => {
        const state = await deps.load();
        if (state.grants.length > 0) await push(state);
        if (state.revoke.length === 0) return;
        const ids = state.revoke;
        try {
          await deps.revokeKeys(ids);
          state.revoke = [];
          await deps.save(state);
          deps.log('shared service revoke retried', { keys: ids.length });
        } catch (error) {
          deps.log('shared service revoke still deferred', { keys: ids.length, reason: (error as { reason?: string }).reason ?? 'unknown' });
        }
      }),
  };
}
