import { describe, expect, it } from 'vitest';
import { createSerialQueue } from '../serialQueue';

describe('createSerialQueue', () => {
  it('runs work one at a time, in order, and carries on after a failure', async () => {
    const serial = createSerialQueue();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = serial(async () => {
      order.push('first start');
      await new Promise<void>((resolve) => (release = resolve));
      order.push('first end');
    });
    const failing = serial(async () => {
      order.push('second');
      throw new Error('boom');
    });
    const third = serial(async () => {
      order.push('third');
      return 3;
    });
    await Promise.resolve();
    expect(order).toEqual(['first start']);
    release();
    await first;
    await expect(failing).rejects.toThrow('boom');
    expect(await third).toBe(3);
    expect(order).toEqual(['first start', 'first end', 'second', 'third']);
  });
});
