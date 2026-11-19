import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureStderr } from '../stderrTail';

describe('captureStderr', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes output through and keeps the last characters up to the limit', async () => {
    const stream = new PassThrough();
    const echoed: string[] = [];
    const capture = captureStderr(stream, { write: (text) => void echoed.push(text) }, 10);
    stream.write('0123456789');
    stream.write('abcde');
    stream.end();

    await expect(capture.settled()).resolves.toEqual({ bytes: 15, tail: '56789abcde' });
    expect(echoed.join('')).toBe('0123456789abcde');
  });

  it('settles after the wait when the stream never ends', async () => {
    const stream = new PassThrough();
    const capture = captureStderr(stream, { write: () => undefined });
    stream.write('Error: boom\n');
    await vi.advanceTimersByTimeAsync(0);

    const settled = capture.settled(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(settled).resolves.toEqual({ bytes: 12, tail: 'Error: boom\n' });
  });

  it('settles at once with nothing when there is no stream', async () => {
    await expect(captureStderr(null).settled()).resolves.toEqual({ bytes: 0, tail: '' });
  });
});
