import type { CircleOfferView } from '../../../shared/types/circles';

export type OfferChangeKind = 'shared' | 'resumed' | 'online' | 'paused' | 'offline' | 'stopped';

/** Something about another member's offer that changes what this user can do. */
export interface OfferChange {
  kind: OfferChangeKind;
  provider: string;
  name: string;
  circle: string;
  models: string[];
}

/** One toast: everything that changed for one provider. */
export interface OfferAlert {
  provider: string;
  text: string;
}

type Reach = 'usable' | 'paused' | 'offline';

/** Offline wins: a paused provider who drops is no more or less usable, and says nothing. */
const reachOf = (offer: CircleOfferView): Reach =>
  !offer.online ? 'offline' : offer.available ? 'usable' : 'paused';

const ids = (offer: CircleOfferView): string[] => offer.models.map((model) => model.id);

/** The changes between two views of one Circle's offers. The user's own offer never counts. */
export function diffOffers(
  circle: string,
  before: CircleOfferView[],
  after: CircleOfferView[]
): OfferChange[] {
  const changes: OfferChange[] = [];
  const add = (kind: OfferChangeKind, offer: CircleOfferView, models: string[]) =>
    changes.push({ kind, provider: offer.identity, name: offer.name, circle, models });

  for (const offer of after) {
    if (offer.isMine) continue;
    const was = before.find((candidate) => candidate.identity === offer.identity);
    const reach = reachOf(offer);
    if (!was) {
      if (reach === 'usable') add('shared', offer, ids(offer));
      continue;
    }
    const wasReach = reachOf(was);
    if (wasReach === 'usable' && reach !== 'usable') add(reach, offer, ids(was));
    else if (wasReach !== 'usable' && reach === 'usable') {
      add(wasReach === 'paused' ? 'resumed' : 'online', offer, ids(offer));
    } else if (reach === 'usable') {
      const added = ids(offer).filter((id) => !ids(was).includes(id));
      const dropped = ids(was).filter((id) => !ids(offer).includes(id));
      if (added.length > 0) add('shared', offer, added);
      if (dropped.length > 0) add('stopped', offer, dropped);
    }
  }
  for (const offer of before) {
    if (offer.isMine || after.some((candidate) => candidate.identity === offer.identity)) continue;
    add('stopped', offer, ids(offer));
  }
  return changes;
}

const joined = (items: string[]): string =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** Names up to two models; a longer list would crowd out the person and the Circle. */
const modelNames = (models: string[]): string =>
  models.length > 2 ? `${models[0]} and ${models.length - 1} more` : joined(models);

function sentence(kind: OfferChangeKind, name: string, models: string[], circles: string[]): string {
  const what = modelNames(models);
  const where = joined(circles);
  const it = models.length === 1 ? 'it' : 'them';
  switch (kind) {
    case 'shared':
      return `${name} shared ${what} with ${where}. You can use ${it} now.`;
    case 'resumed':
      return `${name} resumed ${what} in ${where}. You can use ${it} again.`;
    case 'online':
      return `${name} is back online. You can use ${what} from ${where} again.`;
    case 'paused':
      return `${name} paused ${what} in ${where}. You can't use ${it} until ${name} resumes.`;
    case 'offline':
      return `${name} went offline. You can't use ${what} from ${where} until ${name} is back.`;
    case 'stopped':
      return `${name} stopped sharing ${what} with ${where}. You can't use ${it} now.`;
  }
}

/** One alert per provider; the same change across Circles reads as one sentence. */
export function alertsFor(changes: OfferChange[]): OfferAlert[] {
  const byProvider = new Map<string, OfferChange[]>();
  for (const change of changes) {
    byProvider.set(change.provider, [...(byProvider.get(change.provider) ?? []), change]);
  }
  return [...byProvider].map(([provider, own]) => {
    const kinds = [...new Set(own.map((change) => change.kind))];
    const text = kinds.map((kind) => {
      const same = own.filter((change) => change.kind === kind);
      const models = [...new Set(same.flatMap((change) => change.models))];
      return sentence(kind, same[0].name, models, [...new Set(same.map((change) => change.circle))]);
    });
    return { provider, text: text.join(' ') };
  });
}
