/**
 * What Twenty's page shows of shared services (ADR 0048 §6, §8): the Circles this user shares
 * their Twenty with and each member's access, and the workspaces others share with them. Built
 * from the Circles' `services` records, the provider's grants and the used-services list; never
 * carries a key or a token.
 */
import { usedToday } from '../../../shared/circleUsage';
import { localDay } from '../../../shared/utils/localDay';
import { parseServiceOffer, SERVICES_APP, type ServiceOfferRecord, type ShareLevel } from '../../../shared/serviceOffers';
import type { TwentyAccess } from '../../../shared/types/addons';
import type { CirclesResult } from '../../../shared/types/circles';
import type { OfferedService, ServiceShareInput, SharedServicesView, SharingCircle } from '../../../shared/types/sharedServices';
import { persistDebugLog } from '../../host/log';
import { broadcast } from '../../host/windows';
import { setAwayBlocker } from './awayMode';
import {
  getCircleRecords,
  getCirclesState,
  getSharedServices,
  onCircleRecord,
  onCirclesReady,
} from './circlesService';
import { getServedServiceUsage } from './circlesStore';
import type { CircleRecordEntry } from './networkMessages';
import { getUsedServices } from './usedServicesRuntime';
import { circlesSharing } from './sharingConfig';

/** This Mac's own Twenty, the one service this build shares (spec decision 1). */
const LOCAL_TWENTY = 'twenty.main';

const unwrap = async <T extends object>(result: Promise<CirclesResult<T>>): Promise<T> => {
  const answer = await result;
  if (answer.success === false) throw new Error(answer.error);
  return answer;
};

async function offersIn(circle: string): Promise<CircleRecordEntry[]> {
  const { records } = await unwrap(getCircleRecords(circle, SERVICES_APP));
  return records.filter((record) => record.scope === 'member' && record.identity && parseServiceOffer(record.value));
}

export async function servicesView(): Promise<SharedServicesView> {
  const state = getCirclesState();
  if (state.status !== 'running') return { sharing: [], offered: [] };
  const me = state.snapshot.identity;
  const used = await getUsedServices().list();
  const served = getServedServiceUsage();
  const today = localDay(new Date());
  const sharing: SharingCircle[] = [];
  const offered: OfferedService[] = [];

  for (const circle of state.snapshot.circles) {
    const others = circle.members.filter((member) => !member.isMe);
    let records: CircleRecordEntry[] = [];
    try {
      records = await offersIn(circle.key);
    } catch (error) {
      persistDebugLog('circles', 'services records unread', { circle: circle.key.slice(0, 8), error: error instanceof Error ? error.name : 'unknown' });
    }
    const mine = records.find((record) => record.identity === me && record.key === LOCAL_TWENTY);
    const offer = mine ? parseServiceOffer(mine.value) : null;
    const levels = offer ? await getSharedServices().levels(circle.key, LOCAL_TWENTY) : [];
    sharing.push({
      circle: circle.key,
      circleName: circle.name,
      offer: offer ? { levels: offer.levels, away: offer.away, available: offer.available } : null,
      members: others.map((member) => ({
        identity: member.identity,
        name: member.name,
        level: levels.find((grant) => grant.identity === member.identity)?.level ?? null,
        callsToday: usedToday(served, member.identity, today).requests,
      })),
    });

    for (const record of records) {
      if (record.identity === me) continue;
      const theirs = parseServiceOffer(record.value)!;
      const provider = circle.members.find((member) => member.identity === record.identity);
      if (!provider) continue;
      const use = used.find((entry) => entry.circle === circle.key && entry.provider === provider.identity && entry.service === record.key);
      offered.push({
        circle: circle.key,
        circleName: circle.name,
        provider: provider.identity,
        providerName: provider.name,
        online: provider.online,
        service: record.key,
        name: theirs.name,
        levels: theirs.levels,
        available: theirs.available,
        slug: use?.slug ?? null,
      });
    }
  }
  return { sharing, offered };
}

/** Keeps the Mac awake while any of this user's service offers asks for it (ADR 0048 §8). */
async function syncServiceAway(): Promise<void> {
  const state = getCirclesState();
  if (state.status !== 'running') return setAwayBlocker(false, 'services');
  const me = state.snapshot.identity;
  let away = false;
  for (const circle of state.snapshot.circles) {
    const records = await offersIn(circle.key).catch((): CircleRecordEntry[] => []);
    away ||= records.some((record) => {
      const offer = record.identity === me ? parseServiceOffer(record.value) : null;
      return Boolean(offer?.away && offer.available);
    });
  }
  setAwayBlocker(away, 'services');
}

const changed = (): void => broadcast('circles:services-changed');

/**
 * Share this Mac's Twenty in one Circle, or change how: publishes the offer, then gives each
 * member the level asked for, or takes their access away. A level above what the offer allows is
 * lowered to it.
 */
export async function shareService(input: ServiceShareInput): Promise<void> {
  const shared = getSharedServices();
  const state = getCirclesState();
  const circle = state.snapshot.circles.find((candidate) => candidate.key === input.circle);
  if (!circle) throw new Error('That Circle isn’t on this Mac.');
  const levels: ShareLevel[] = input.write ? ['read', 'write'] : ['read'];
  const offer: ServiceOfferRecord = { kind: 'twenty', name: 'Twenty', levels, available: true, away: input.away };
  await shared.offer(circle.key, LOCAL_TWENTY, offer);
  for (const member of circle.members) {
    if (member.isMe || !(member.identity in input.members)) continue;
    const asked = input.members[member.identity];
    if (asked === null || asked === undefined) {
      await shared.revoke(circle.key, LOCAL_TWENTY, member.identity);
      continue;
    }
    await shared.grant({
      circle: circle.key,
      service: LOCAL_TWENTY,
      identity: member.identity,
      memberName: member.name,
      circleName: circle.name,
      level: asked === 'write' && input.write ? 'write' : 'read',
    });
  }
  await syncServiceAway();
  changed();
}

/** Stop sharing this Mac's Twenty in a Circle; every member's keys are revoked. */
export async function stopSharingService(circle: string): Promise<void> {
  await getSharedServices().withdraw(circle, LOCAL_TWENTY);
  await syncServiceAway();
  changed();
}

/** **Use in my agent** on. */
export async function useService(input: { circle: string; provider: string; service: string; access: TwentyAccess }): Promise<{ slug: string }> {
  // The workspace calls a listener on this machine, which the stack's containers must reach.
  circlesSharing().requireHostCallbacks();
  const circle = getCirclesState().snapshot.circles.find((candidate) => candidate.key === input.circle);
  const provider = circle?.members.find((member) => member.identity === input.provider);
  if (!circle || !provider) throw new Error('That person or Circle isn’t on this Mac any more.');
  const result = await getUsedServices().use({
    circle: circle.key,
    provider: provider.identity,
    service: input.service,
    providerName: provider.name,
    circleName: circle.name,
    access: input.access,
  });
  changed();
  return result;
}

/** **Use in my agent** off. */
export async function stopUsingService(input: { circle: string; provider: string; service: string }): Promise<void> {
  await getUsedServices().stopUsing(input.circle, input.provider, input.service);
  changed();
}

/** Tells the page when an offer appears, changes or goes, and keeps away mode in step. */
export function listenForServices(): void {
  onCircleRecord(SERVICES_APP, () => {
    changed();
    void syncServiceAway().catch((): void => undefined);
  });
  onCirclesReady(() => void syncServiceAway().catch((): void => undefined));
}
