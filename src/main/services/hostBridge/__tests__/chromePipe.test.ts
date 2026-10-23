import { describe, expect, it } from 'vitest';
import { chromeArgs, splitFrames } from '../chromePipe';

describe('chromeArgs', () => {
  it('uses the pipe, never a port, and hides automation without the warning bar', () => {
    const args = chromeArgs('/tmp/profile');
    expect(args).toContain('--user-data-dir=/tmp/profile');
    expect(args).toContain('--remote-debugging-pipe');
    expect(args.some((arg) => arg.startsWith('--remote-debugging-port'))).toBe(false);
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    expect(args).toContain('--test-type');
  });
});

describe('splitFrames', () => {
  it('splits NUL-terminated messages and keeps the unfinished tail', () => {
    const frames: string[] = [];
    const rest = splitFrames('{"a":1}\0{"b":2}\0{"c"', (frame) => frames.push(frame));
    expect(frames).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('{"c"');
  });
});
