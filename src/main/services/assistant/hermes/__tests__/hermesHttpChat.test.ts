import { describe, expect, it } from 'vitest';
import { parseHermesSseLines } from '../hermesHttpChat';

describe('parseHermesSseLines', () => {
  it('accumulates text deltas and finish reason', () => {
    const deltas: string[] = [];
    const input =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n' +
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n' +
      'data: [DONE]\n';

    const result = parseHermesSseLines(input, (d) => deltas.push(d));
    expect(deltas.join('')).toBe('Hello world');
    expect(result.done).toBe(true);
    expect(result.finishReason).toBe('stop');
    expect(result.remainder).toBe('');
  });

  it('keeps incomplete trailing line as remainder', () => {
    const deltas: string[] = [];
    const result = parseHermesSseLines(
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\ndata: {"choices"',
      (d) => deltas.push(d)
    );
    expect(deltas).toEqual(['Hi']);
    expect(result.done).toBe(false);
    expect(result.remainder).toBe('data: {"choices"');
  });
});
