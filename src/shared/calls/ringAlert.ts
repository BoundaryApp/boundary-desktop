/**
 * What the page tells main about calls ringing for this user, so main can alert outside the
 * window (Circle calls spec decision 5): a system notification, a Dock bounce and a ring sound
 * while the window isn't in front.
 */

/** One call ringing for this user, with the words its notification shows. */
export interface RingAlert {
  room: string;
  /** "Sam is calling". */
  title: string;
  /** "Book club · just you two". */
  body: string;
}

/** What the user chose on a ring's notification. */
export interface RingAction {
  room: string;
  action: 'answer' | 'decline';
}

const MAX_RINGS = 16;
const MAX_TEXT = 200;
const MAX_ROOM = 64;

/** Text cut to `max` characters, with `…` when cut; null for anything but a non-empty string. */
function clamp(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * The rings the page sent, or null for anything but a list. Long titles and bodies are cut,
 * items that aren't rings are dropped, duplicate rooms keep the first, and only the first 16
 * are kept: one bad item must not leave main holding an older list.
 */
export function parseRingAlerts(input: unknown): RingAlert[] | null {
  if (!Array.isArray(input)) return null;
  const rings: RingAlert[] = [];
  for (const item of input) {
    if (rings.length === MAX_RINGS) break;
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    const title = clamp(raw.title, MAX_TEXT);
    const body = clamp(raw.body, MAX_TEXT);
    const room = typeof raw.room === 'string' && raw.room.length > 0 && raw.room.length <= MAX_ROOM ? raw.room : null;
    if (!room || !title || !body) continue;
    if (!rings.some((ring) => ring.room === room)) rings.push({ room, title, body });
  }
  return rings;
}
