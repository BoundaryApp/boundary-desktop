import { describe, expect, it } from 'vitest';
import {
  CALL_PART_CHARS,
  CALL_PART_TTL_MS,
  CallPartAssembler,
  MAX_CALL_PARTS,
  isCallPart,
  packCallMessage,
} from '../callSignalParts';

/** Text that deflate can't shrink much, so it needs several parts. */
function noisy(chars: number): string {
  let seed = 7;
  let text = '';
  while (text.length < chars) {
    seed = (seed * 48271) % 2147483647;
    text += seed.toString(36);
  }
  return text.slice(0, chars);
}

describe('call signal parts', () => {
  it('sends a small message as one part and gets it back', async () => {
    const message = { t: 'offer', sdp: 'v=0\r\n'.repeat(200) };
    const packed = await packCallMessage(message);
    expect(packed.parts).toHaveLength(1);
    expect(packed.sentChars).toBeLessThan(packed.rawBytes);
    expect(packed.parts.every(isCallPart)).toBe(true);
    expect(await new CallPartAssembler().add('ada', packed.parts[0])).toEqual(message);
  });

  it('splits a large message, and puts the parts back in any order', async () => {
    const message = { t: 'offer', sdp: noisy(9_000) };
    const packed = await packCallMessage(message);
    expect(packed.parts.length).toBeGreaterThan(1);
    expect(packed.parts.every((part) => part.z.length <= CALL_PART_CHARS)).toBe(true);
    expect(packed.parts.every((part) => JSON.stringify(part).length < 4096)).toBe(true);
    const assembler = new CallPartAssembler();
    const [first, ...rest] = packed.parts;
    for (const part of rest.reverse()) expect(await assembler.add('ada', part)).toBeNull();
    expect(await assembler.add('ada', first)).toEqual(message);
    expect(assembler.waiting).toBe(0);
  });

  it('ignores a repeated part', async () => {
    const packed = await packCallMessage({ sdp: noisy(7_000) });
    const assembler = new CallPartAssembler();
    expect(await assembler.add('ada', packed.parts[0])).toBeNull();
    expect(await assembler.add('ada', packed.parts[0])).toBeNull();
    expect(assembler.waiting).toBe(1);
  });

  it('keeps senders apart', async () => {
    const packed = await packCallMessage({ sdp: noisy(7_000) });
    const assembler = new CallPartAssembler();
    expect(await assembler.add('ada', packed.parts[0])).toBeNull();
    expect(await assembler.add('bo', packed.parts[1])).toBeNull();
    expect(assembler.waiting).toBe(2);
  });

  it('drops a message whose parts disagree about the count', async () => {
    const packed = await packCallMessage({ sdp: noisy(7_000) });
    const assembler = new CallPartAssembler();
    await assembler.add('ada', packed.parts[0]);
    expect(await assembler.add('ada', { ...packed.parts[1], of: packed.parts[1].of + 1 })).toBeNull();
    expect(assembler.waiting).toBe(0);
  });

  it('drops a message whose parts stop arriving', async () => {
    const packed = await packCallMessage({ sdp: noisy(7_000) });
    const assembler = new CallPartAssembler();
    await assembler.add('ada', packed.parts[0], 1_000);
    const other = await packCallMessage({ t: 'bye' });
    await assembler.add('ada', other.parts[0], 1_000 + CALL_PART_TTL_MS + 1);
    expect(assembler.waiting).toBe(0);
  });

  it('refuses a message that needs too many parts', async () => {
    await expect(packCallMessage({ sdp: noisy(CALL_PART_CHARS * (MAX_CALL_PARTS + 2)) })).rejects.toThrow(/too large/);
  });

  it('rejects parts with the wrong shape', () => {
    const good = { t: 'part', id: '0123456789abcdef', n: 0, of: 1, z: 'eA==' };
    expect(isCallPart(good)).toBe(true);
    expect(isCallPart({ ...good, id: 'nothex' })).toBe(false);
    expect(isCallPart({ ...good, n: 1 })).toBe(false);
    expect(isCallPart({ ...good, of: MAX_CALL_PARTS + 1 })).toBe(false);
    expect(isCallPart({ ...good, z: 'x'.repeat(CALL_PART_CHARS + 1) })).toBe(false);
    expect(isCallPart(null)).toBe(false);
  });

  it('returns null for parts that are not a deflated message', async () => {
    const assembler = new CallPartAssembler();
    expect(await assembler.add('ada', { t: 'part', id: '0123456789abcdef', n: 0, of: 1, z: 'bm90IGRlZmxhdGU=' })).toBeNull();
  });
});
