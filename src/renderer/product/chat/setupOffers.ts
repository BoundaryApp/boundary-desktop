import type { HermesChatToolEvent } from '../../../shared/types/hermesChat';
import { useCalendarAccounts } from '../useCalendarAccounts';
import { createIpcStore, useIpcStore } from '../../lib/ipcStore';

/**
 * Cards Hermes asked for with the host bridge's `offer_setup` (calendar spec, decision 7). Kept
 * outside the thread, which unmounts when the card sends the user to Settings, so the card is
 * still there if they close the sheet and come back. A chat's next turn replaces it.
 */

export type SetupKind = 'calendar';

export interface SetupOffer {
  chatId: string;
  requestId: string;
  kind: SetupKind;
}

type SameChat = (a: string, b: string) => boolean;
const sameId: SameChat = (a, b) => a === b;

// Hermes names MCP tools `mcp_<server>_<tool>`.
const OFFER_TOOL = /(^|[^a-z])offer_setup$/i;

/** The card a finished tool call asks for, or null. */
export function setupOfferKind(event: Pick<HermesChatToolEvent, 'name' | 'status' | 'args'>): SetupKind | null {
  if (event.status !== 'done' || !OFFER_TOOL.test(event.name.trim())) return null;
  const kind = event.args?.kind;
  return kind === undefined || kind === 'calendar' ? 'calendar' : null;
}

const offers = createIpcStore<readonly SetupOffer[]>({ initial: [] });

/** One card per chat: a new one replaces the last. */
export function recordSetupOffer(offer: SetupOffer, sameChat: SameChat = sameId): void {
  offers.update((all) => [...all.filter((o) => !sameChat(o.chatId, offer.chatId)), offer]);
}

export function clearSetupOffer(chatId: string, sameChat: SameChat = sameId): void {
  const all = offers.get();
  if (all.some((o) => sameChat(o.chatId, chatId))) offers.set(all.filter((o) => !sameChat(o.chatId, chatId)));
}

/**
 * The open chat's card, unless a calendar has been connected since. While the list is unknown the
 * card shows: Boundary listed the tool only because no calendar was connected.
 */
export function useSetupOffer(chatId: string | null, sameChat: SameChat = sameId): SetupOffer | null {
  const all = useIpcStore(offers);
  const calendars = useCalendarAccounts();
  if (!chatId || (calendars && calendars.length > 0)) return null;
  return all.find((o) => sameChat(o.chatId, chatId)) ?? null;
}
