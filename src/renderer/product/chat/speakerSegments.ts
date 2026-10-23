/**
 * A room wake streams several agents' replies into one live message. Each run of text from
 * one agent is a segment, so the thread can name every speaker while it streams, the way
 * the reloaded history does with one message per reply (ADR 0010 §1).
 */
export interface SpeakerSegment {
  agentSlug: string | null;
  text: string;
}

/** Adds a streamed chunk, starting a new segment when a different agent speaks. */
export function appendSpeakerChunk(
  segments: SpeakerSegment[],
  delta: string,
  agentSlug: string | null | undefined
): void {
  const slug = agentSlug ?? null;
  const last = segments.at(-1);
  if (last && (slug === null || last.agentSlug === null || last.agentSlug === slug)) {
    last.agentSlug ??= slug;
    last.text += delta;
    return;
  }
  segments.push({ agentSlug: slug, text: delta });
}

/** The message text: one paragraph break between speakers. */
export function joinSpeakerSegments(segments: readonly SpeakerSegment[]): string {
  return segments.map((s) => s.text).join('\n\n');
}

/** Segments stored on a message, when more than one agent spoke in it. */
export function speakerSegmentsOf(custom: unknown): SpeakerSegment[] | null {
  const segments = (custom as { segments?: unknown } | undefined)?.segments;
  if (!Array.isArray(segments) || segments.length < 2) return null;
  return segments as SpeakerSegment[];
}
