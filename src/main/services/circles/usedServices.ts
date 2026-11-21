/**
 * Services this user uses from their Circles (ADR 0048 §5–6): **Use in my agent** for one offer.
 * Each used service gets a loopback listener on a port kept across launches, with a random token
 * per level, and a Twenty workspace in the stack's store that points Hermes at it through
 * `host.docker.internal`. The tokens are kept encrypted and are worthless off this Mac: the
 * listener only forwards to the provider's gateway, which holds this member's real keys.
 *
 * Boundary writes the workspace itself rather than calling `crm.sh add`, because `crm.sh` checks
 * the URL from the Mac, where `host.docker.internal` doesn't resolve (change request 0025 R2).
 */
import { randomBytes } from 'node:crypto';
import type { TwentyAccess } from '../../../shared/types/addons';
import type { ShareLevel } from '../../../shared/serviceOffers';
import { createSerialQueue } from '../../../shared/utils/serialQueue';
import { slugify } from '../../../shared/utils/slug';
import type { ServiceListener } from './serviceListener';

/** One used service as kept on this Mac. */
export interface UsedService {
  /** The Circle's key. */
  circle: string;
  /** The provider's identity. */
  provider: string;
  /** The offer's key in the provider's `services` record. */
  service: string;
  /** The stack registers it as `crm-<slug>`. */
  slug: string;
  port: number;
  tokens: Record<ShareLevel, string>;
}

/** The stack's Twenty workspace store, as far as this needs it. */
export interface WorkspaceStore {
  slugFree(slug: string): Promise<boolean>;
  exists(slug: string): Promise<boolean>;
  write(slug: string, values: { url: string; access: TwentyAccess }, keys: { ro: string; rw: string }): Promise<void>;
  setUrl(slug: string, url: string): Promise<void>;
  remove(slug: string): Promise<void>;
}

export interface UsedServicesDeps {
  load(): Promise<UsedService[]>;
  save(list: UsedService[]): Promise<void>;
  /** Null while no stack folder resolves. */
  store(): WorkspaceStore | null;
  /** Starts a listener for `entry` on `port` (0 for any free one). */
  listen(entry: UsedService, port: number): Promise<ServiceListener>;
  /** A line for the restart bar. */
  pending(text: string): void;
  /** Runs `work` under the add-on lock, so it can't overlap other workspace changes. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  /** Metadata only. */
  log(message: string, data?: Record<string, unknown>): void;
  token?(): string;
}

export interface UseInput {
  circle: string;
  provider: string;
  service: string;
  /** For the slug. */
  providerName: string;
  circleName: string;
  access: TwentyAccess;
}

const ACCESS_LABEL: Record<TwentyAccess, string> = { read: 'look things up', write: 'make changes' };
const SLUG_BASE_MAX = 26;

/** The workspace URL Hermes uses for a listener on this Mac's loopback. */
export const listenerUrl = (port: number): string => `http://host.docker.internal:${port}`;

/**
 * A slug from the provider's and Circle's names, unique on this Mac (ADR 0048 §5): letters,
 * digits and `-`, starting with a letter, at most 31 characters, as the stack requires.
 */
export async function sharedWorkspaceSlug(
  providerName: string,
  circleName: string,
  free: (slug: string) => boolean | Promise<boolean>
): Promise<string> {
  let base =
    [providerName, circleName]
      .map((name) => slugify(name, { stripDiacritics: true }))
      .filter(Boolean)
      .join('-') || 'shared';
  if (!/^[a-z]/.test(base)) base = `s-${base}`;
  base = base.slice(0, SLUG_BASE_MAX).replace(/-+$/, '');
  if (await free(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const slug = `${base}-${n}`;
    if (await free(slug)) return slug;
  }
  throw new Error('No free workspace name is left for this service.');
}

const same = (entry: UsedService, circle: string, provider: string, service: string): boolean =>
  entry.circle === circle && entry.provider === provider && entry.service === service;

const isAddressInUse = (error: unknown): boolean => (error as { code?: unknown })?.code === 'EADDRINUSE';

export function createUsedServices(deps: UsedServicesDeps) {
  const serial = createSerialQueue();
  const listeners = new Map<string, ServiceListener>();
  const token = deps.token ?? (() => randomBytes(32).toString('base64url'));

  const requireStore = (): WorkspaceStore => {
    const store = deps.store();
    if (!store) throw new Error('The agent stack folder could not be found.');
    return store;
  };

  /** Starts `entry`'s listener on its kept port, or on a new one when that is taken. */
  async function open(entry: UsedService, store: WorkspaceStore): Promise<UsedService> {
    try {
      listeners.set(entry.slug, await deps.listen(entry, entry.port));
      return entry;
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
    }
    const listener = await deps.listen(entry, 0);
    listeners.set(entry.slug, listener);
    await store.setUrl(entry.slug, listenerUrl(listener.port));
    deps.pending(`crm-${entry.slug}: moved to a free port`);
    deps.log('shared service port moved', { slug: entry.slug, from: entry.port, to: listener.port });
    return { ...entry, port: listener.port };
  }

  async function close(slug: string): Promise<void> {
    const listener = listeners.get(slug);
    listeners.delete(slug);
    await listener?.close();
  }

  return {
    /** **Use in my agent**: registers the offer as a workspace. Agents get it at the next restart. */
    use: (input: UseInput): Promise<{ slug: string }> =>
      serial(() =>
        deps.exclusive(async () => {
          const list = await deps.load();
          const existing = list.find((entry) => same(entry, input.circle, input.provider, input.service));
          if (existing) return { slug: existing.slug };
          const store = requireStore();
          const taken = new Set(list.map((entry) => entry.slug));
          const slug = await sharedWorkspaceSlug(input.providerName, input.circleName, async (s) => !taken.has(s) && (await store.slugFree(s)));
          const draft: UsedService = {
            circle: input.circle,
            provider: input.provider,
            service: input.service,
            slug,
            port: 0,
            tokens: { read: token(), write: token() },
          };
          const listener = await deps.listen(draft, 0);
          const entry = { ...draft, port: listener.port };
          listeners.set(slug, listener);
          try {
            await store.write(slug, { url: listenerUrl(entry.port), access: input.access }, { ro: entry.tokens.read, rw: entry.tokens.write });
            await deps.save([...list, entry]);
          } catch (error) {
            await store.remove(slug);
            await close(slug);
            throw error;
          }
          deps.pending(`Connect crm-${slug} (${ACCESS_LABEL[input.access]})`);
          deps.log('shared service used', { slug, service: input.service, circle: input.circle.slice(0, 8) });
          return { slug };
        })
      ),

    /** Turns **Use in my agent** off: the workspace goes at the next restart, the listener now. */
    stopUsing: (circle: string, provider: string, service: string): Promise<void> =>
      serial(() =>
        deps.exclusive(async () => {
          const list = await deps.load();
          const entry = list.find((candidate) => same(candidate, circle, provider, service));
          if (!entry) return;
          await deps.save(list.filter((candidate) => candidate !== entry));
          await deps.store()?.remove(entry.slug);
          await close(entry.slug);
          deps.pending(`Disconnect crm-${entry.slug}`);
          deps.log('shared service no longer used', { slug: entry.slug, service });
        })
      ),

    /**
     * Opens every used service's listener, at launch. A workspace someone removed from the stack
     * is dropped; a kept port that is taken moves, and the restart bar says so.
     */
    startAll: (): Promise<void> =>
      serial(async () => {
        const store = deps.store();
        if (!store) return;
        const list = await deps.load();
        const kept: UsedService[] = [];
        let changed = false;
        for (const entry of list) {
          if (listeners.has(entry.slug)) {
            kept.push(entry);
            continue;
          }
          if (!(await store.exists(entry.slug))) {
            changed = true;
            deps.log('shared service workspace gone', { slug: entry.slug });
            continue;
          }
          try {
            const opened = await open(entry, store);
            changed ||= opened.port !== entry.port;
            kept.push(opened);
          } catch (error) {
            kept.push(entry);
            deps.log('shared service listener not started', { slug: entry.slug, error: error instanceof Error ? error.name : 'unknown' });
          }
        }
        if (changed) await deps.save(kept);
      }),

    /** Closes every listener, at quit. */
    closeAll: (): Promise<void> =>
      serial(async (): Promise<void> => {
        await Promise.all([...listeners.keys()].map(close));
      }),

    /** What this user uses, without tokens. */
    list: (): Promise<Array<Pick<UsedService, 'circle' | 'provider' | 'service' | 'slug'>>> =>
      serial(async () => (await deps.load()).map(({ circle, provider, service, slug }) => ({ circle, provider, service, slug }))),
  };
}

export type UsedServices = ReturnType<typeof createUsedServices>;
