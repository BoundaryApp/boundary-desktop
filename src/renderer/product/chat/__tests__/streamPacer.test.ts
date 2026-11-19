import { describe, expect, it } from 'vitest';
import {
  CUSHION_MS,
  END_DRAIN_MS,
  FIRST_HOLD_MS,
  firstWordEnd,
  lastWordBoundary,
  MIN_CHARS_PER_SEC,
  StreamPacer,
} from '../streamPacer';

/** Tick every 16 ms from `from` to `to`, returning the last frame. */
function run(pacer: StreamPacer, from: number, to: number) {
  let frame = pacer.tick(from);
  for (let t = from + 16; t <= to; t += 16) frame = pacer.tick(t);
  return frame;
}

describe('word boundaries', () => {
  it('finds the end of the first and last whole word', () => {
    expect(firstWordEnd('')).toBe(0);
    expect(firstWordEnd('  Hel')).toBe(0);
    expect(firstWordEnd('  Hello there')).toBe(8);
    expect(lastWordBoundary('Hello there fri', 15)).toBe(12);
    expect(lastWordBoundary('Hello', 5)).toBe(0);
  });
});

describe('StreamPacer', () => {
  it('shows nothing before any text', () => {
    const pacer = new StreamPacer();
    pacer.update('', false, 0);
    expect(pacer.tick(0)).toEqual({ shown: 0, pacing: true });
  });

  it('shows the first word as soon as it is whole', () => {
    const pacer = new StreamPacer();
    pacer.update('Hel', false, 0);
    expect(pacer.tick(0).shown).toBe(0);
    pacer.update('Hello th', false, 40);
    expect(pacer.tick(40).shown).toBe('Hello '.length);
  });

  it('shows an unfinished first word once the hold runs out', () => {
    const pacer = new StreamPacer();
    pacer.update('Sure', false, 0);
    expect(run(pacer, 0, FIRST_HOLD_MS - 16).shown).toBe(0);
    expect(pacer.tick(FIRST_HOLD_MS).shown).toBe(4);
  });

  it('never stops mid-word while streaming', () => {
    const pacer = new StreamPacer();
    const text = 'one two three four five six seven eight nine ten eleven twelve ';
    pacer.update(text, false, 0);
    for (let t = 0; t <= 2000; t += 16) {
      const { shown } = pacer.tick(t);
      expect(shown === 0 || /\s/.test(text[shown - 1])).toBe(true);
    }
  });

  it('turns a burst into a steady reveal with a cushion in hand', () => {
    const pacer = new StreamPacer();
    const word = 'word ';
    let text = '';
    let shownAt1s = 0;
    // 60 chars/sec arriving as one 60-char burst every second.
    for (let t = 0; t <= 5000; t += 16) {
      if (t % 1008 === 0) {
        text += word.repeat(12);
        pacer.update(text, false, t);
      }
      const { shown } = pacer.tick(t);
      if (t === 1008 - 16) shownAt1s = shown;
    }
    // Partway through the first second, part of the burst is shown, not all of it.
    expect(shownAt1s).toBeGreaterThan(5);
    expect(shownAt1s).toBeLessThan(60);
  });

  it('slows through a stall instead of stopping, never below the floor', () => {
    const pacer = new StreamPacer();
    const text = 'word '.repeat(40);
    pacer.update(text, false, 0);
    const a = run(pacer, 0, 1000).shown;
    const b = run(pacer, 1016, 2000).shown;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeGreaterThanOrEqual(MIN_CHARS_PER_SEC - 5);
    expect(b).toBeLessThan(text.length);
  });

  it('settles with about the cushion in hand on a steady stream', () => {
    const pacer = new StreamPacer();
    let text = '';
    const perSec = 200;
    for (let t = 0; t <= 6000; t += 16) {
      text += 'abcd '.repeat(Math.round((perSec * 16) / 1000 / 5));
      pacer.update(text, false, t);
      pacer.tick(t);
    }
    const backlog = text.length - pacer.tick(6016).shown;
    const arrival = Math.round((perSec * 16) / 1000 / 5) * 5 * (1000 / 16);
    const cushion = (arrival * CUSHION_MS) / 1000;
    expect(backlog).toBeGreaterThan(cushion * 0.7);
    expect(backlog).toBeLessThan(cushion * 1.3);
  });

  it('shows the rest within the end drain once the stream ends', () => {
    const pacer = new StreamPacer();
    const text = 'word '.repeat(200);
    pacer.update(text, false, 0);
    run(pacer, 0, 500);
    pacer.update(text, true, 500);
    expect(run(pacer, 516, 500 + END_DRAIN_MS + 32)).toEqual({ shown: text.length, pacing: false });
  });

  it('shows a stream that ended before the first word at once', () => {
    const pacer = new StreamPacer();
    pacer.update('Ok', true, 0);
    expect(run(pacer, 0, END_DRAIN_MS + 32)).toEqual({ shown: 2, pacing: false });
  });

  it('restarts from the shared part when the text is replaced', () => {
    const pacer = new StreamPacer();
    pacer.update('alpha beta gamma delta ', true, 0);
    run(pacer, 0, 1000);
    pacer.update('alpha bravo ', false, 1000);
    expect(pacer.tick(1000).shown).toBeLessThanOrEqual('alpha b'.length);
  });
});
