/**
 * A provider's offer of a service to a Circle (ADR 0048 §2): one `member`-scope Circle record per
 * offered service, in the `services` app, keyed by the service's id. Every member can read it and
 * keeps it after leaving, so it carries no grants and no keys. Records come from other members'
 * devices, so readers check each value with `parseServiceOffer`.
 */

/** The Circle record app that holds offers. */
export const SERVICES_APP = 'services';

/** What a grant lets a member do: look things up, or also change records. */
export type ShareLevel = 'read' | 'write';

/** Kinds this build can share (spec decision 1). */
export type ServiceKind = 'twenty';

export interface ServiceOfferRecord {
  kind: ServiceKind;
  /** What members see, such as the workspace's name. */
  name: string;
  /** The levels the provider grants in this Circle: `['read']` or `['read', 'write']`. */
  levels: ShareLevel[];
  /** False while the provider has paused sharing; members see it but calls are refused. */
  available: boolean;
  /** The provider keeps their Mac awake for it (ADR 0048 §8). */
  away: boolean;
}

const MAX_NAME = 100;
const KINDS: readonly string[] = ['twenty'];

/** The offer in a record's value, or null when it isn't one this build understands. */
export function parseServiceOffer(value: unknown): ServiceOfferRecord | null {
  const offer = value as Partial<ServiceOfferRecord> | null;
  if (typeof offer !== 'object' || offer === null || Array.isArray(offer)) return null;
  if (typeof offer.kind !== 'string' || !KINDS.includes(offer.kind)) return null;
  if (typeof offer.name !== 'string') return null;
  const name = offer.name.trim();
  if (!name || name.length > MAX_NAME) return null;
  if (!Array.isArray(offer.levels)) return null;
  const levels: ShareLevel[] = offer.levels.includes('write') ? ['read', 'write'] : ['read'];
  if (!offer.levels.includes('read')) return null;
  if (offer.levels.some((level) => level !== 'read' && level !== 'write')) return null;
  if (typeof offer.available !== 'boolean' || typeof offer.away !== 'boolean') return null;
  return { kind: offer.kind as ServiceKind, name, levels, available: offer.available, away: offer.away };
}
