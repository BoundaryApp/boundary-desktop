import React, { createContext, useContext } from 'react';
import { useAuiState } from '@assistant-ui/store';
import { localDayKey } from '../../../shared/messageTime';
import { DayDivider } from './MessageActions';
import { messageTimeMs } from './messageMeta';

// Project moves and inference switches, drawn in the transcript where they happened
// (ADR 0024): before the first message newer than the mark, or after the last message.

export interface TranscriptMark {
  id: string;
  /** ISO time the mark was made. A mark without a readable time is not drawn. */
  at: string;
  text: string;
  className: string;
}

export interface PlacedMarks {
  /** Marks to draw above a message, by message id, oldest first. */
  before: ReadonlyMap<string, TranscriptMark[]>;
  /** Marks newer than every timed message. */
  atEnd: TranscriptMark[];
}

const NO_MARKS: PlacedMarks = { before: new Map(), atEnd: [] };

type TimedMessage = Parameters<typeof messageTimeMs>[0] & { id: string };

/**
 * Each message's id and time as one string, for a store selector that stays equal while a
 * reply streams. Messages without a time are left out.
 */
export function messageTimesKey(messages: readonly TimedMessage[]): string {
  return messages
    .flatMap((message) => {
      const ms = messageTimeMs(message);
      return ms == null ? [] : [`${ms} ${message.id}`];
    })
    .join('\n');
}

/** Puts each mark before the first message newer than it (messages as `messageTimesKey` lists them). */
export function placeTranscriptMarks(
  marks: readonly TranscriptMark[],
  messageTimes: string
): PlacedMarks {
  const timed = messageTimes
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ');
      return { ms: Number(line.slice(0, space)), id: line.slice(space + 1) };
    });
  const before = new Map<string, TranscriptMark[]>();
  const atEnd: TranscriptMark[] = [];
  const dated = marks
    .map((mark) => ({ mark, ms: Date.parse(mark.at) }))
    .filter((m) => Number.isFinite(m.ms))
    .sort((a, b) => a.ms - b.ms);
  for (const { mark, ms } of dated) {
    const next = timed.find((message) => message.ms > ms);
    if (!next) {
      atEnd.push(mark);
      continue;
    }
    const list = before.get(next.id) ?? [];
    list.push(mark);
    before.set(next.id, list);
  }
  return { before, atEnd };
}

export const TranscriptMarksContext = createContext<PlacedMarks>(NO_MARKS);

const MarkLines: React.FC<{ marks: readonly TranscriptMark[] }> = ({ marks }) => (
  <>
    {marks.map((mark) => (
      <div key={mark.id} className={mark.className}>
        {mark.text}
      </div>
    ))}
  </>
);

/**
 * At the top of a message: its day divider, with the marks placed before it. Marks from an
 * earlier day go above the divider, marks from the message's own day below it.
 */
export const DayDividerWithMarks: React.FC = () => {
  const { before } = useContext(TranscriptMarksContext);
  const id = useAuiState((s) => s.message.id);
  const ms = useAuiState((s) => messageTimeMs(s.message));
  const marks = before.get(id) ?? [];
  const day = ms == null ? null : localDayKey(ms);
  const earlier = marks.filter((mark) => localDayKey(Date.parse(mark.at)) !== day);
  const sameDay = marks.filter((mark) => localDayKey(Date.parse(mark.at)) === day);
  return (
    <>
      <MarkLines marks={earlier} />
      <DayDivider />
      <MarkLines marks={sameDay} />
    </>
  );
};

/** After the transcript: marks newer than every message. */
export const TranscriptMarksAtEnd: React.FC = () => (
  <MarkLines marks={useContext(TranscriptMarksContext).atEnd} />
);
