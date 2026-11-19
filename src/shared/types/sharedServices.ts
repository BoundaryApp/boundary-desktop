/**
 * Shared services as Twenty's page shows them (ADR 0048). No key or token ever appears here.
 */
import type { ShareLevel } from '../serviceOffers';

/** One Circle this user could share their Twenty with, and how they share it there. */
export interface SharingCircle {
  circle: string;
  circleName: string;
  /** Null while this user doesn't share in this Circle. */
  offer: { levels: ShareLevel[]; away: boolean; available: boolean } | null;
  /** The other members, with the access each has now and today's calls. */
  members: Array<{ identity: string; name: string; level: ShareLevel | null; callsToday: number }>;
}

/** A workspace another member shares with this user. */
export interface OfferedService {
  circle: string;
  circleName: string;
  provider: string;
  providerName: string;
  online: boolean;
  /** The offer's key in the provider's `services` record. */
  service: string;
  name: string;
  /** What the provider allows in this Circle; each member's own grant may be less. */
  levels: ShareLevel[];
  available: boolean;
  /** Set while this user has **Use in my agent** on: the agents see `crm-<slug>`. */
  slug: string | null;
}

export interface SharedServicesView {
  sharing: SharingCircle[];
  offered: OfferedService[];
}

/** Share Twenty in a Circle, or change how. */
export interface ServiceShareInput {
  circle: string;
  /** Members may make changes, for those given it; otherwise everyone only looks things up. */
  write: boolean;
  away: boolean;
  /** By identity: the level to give, or null to take access away. Members left out stay as they are. */
  members: Record<string, ShareLevel | null>;
}
