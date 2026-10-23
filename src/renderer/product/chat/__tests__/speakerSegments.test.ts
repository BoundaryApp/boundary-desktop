import { describe, expect, it } from 'vitest';
import {
  appendSpeakerChunk,
  joinSpeakerSegments,
  speakerSegmentsOf,
  type SpeakerSegment,
} from '../speakerSegments';

describe('speaker segments (ADR 0010 §1)', () => {
  it('starts a new segment only when a different agent speaks', () => {
    const segments: SpeakerSegment[] = [];
    appendSpeakerChunk(segments, 'Two ', 'ana');
    appendSpeakerChunk(segments, 'vendors.', 'ana');
    appendSpeakerChunk(segments, 'Confirmed.', 'assistant');
    expect(segments).toEqual([
      { agentSlug: 'ana', text: 'Two vendors.' },
      { agentSlug: 'assistant', text: 'Confirmed.' },
    ]);
    expect(joinSpeakerSegments(segments)).toBe('Two vendors.\n\nConfirmed.');
  });

  it('keeps untagged chunks with the current speaker', () => {
    const segments: SpeakerSegment[] = [];
    appendSpeakerChunk(segments, 'Hel', undefined);
    appendSpeakerChunk(segments, 'lo', 'ana');
    appendSpeakerChunk(segments, '!', null);
    expect(segments).toEqual([{ agentSlug: 'ana', text: 'Hello!' }]);
  });

  it('reads segments back only when more than one agent spoke', () => {
    const two = [
      { agentSlug: 'ana', text: 'a' },
      { agentSlug: 'assistant', text: 'b' },
    ];
    expect(speakerSegmentsOf({ segments: two })).toEqual(two);
    expect(speakerSegmentsOf({ segments: [two[0]] })).toBeNull();
    expect(speakerSegmentsOf(undefined)).toBeNull();
  });
});
