import type { SecretStream } from 'hyperswarm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNAL_RECEIVE_RATE, SIGNAL_SEND_RATE } from '../circleSignals';
import { SignalLink } from '../signalChannel';

const fake = vi.hoisted(() => ({
  opts: null as null | { onopen(): void; onclose(isRemote: boolean): void },
  onmessage: null as null | ((raw: Buffer) => void),
  sent: [] as Buffer[],
  refuse: false,
}));

vi.mock('protomux', () => ({
  default: {
    from: () => ({
      createChannel: (opts: typeof fake.opts) => {
        if (fake.refuse) return null;
        fake.opts = opts;
        return {
          open: () => undefined,
          addMessage: ({ onmessage }: { onmessage: (raw: Buffer) => void }) => {
            fake.onmessage = onmessage;
            return { send: (raw: Buffer) => fake.sent.push(raw) };
          },
        };
      },
    }),
  },
}));

const connection = {} as SecretStream;
const frame = (text: string) => Buffer.from(text);

beforeEach(() => {
  vi.useFakeTimers();
  fake.sent = [];
  fake.refuse = false;
});

afterEach(() => {
  vi.useRealTimers();
});

function attach() {
  const frames: Buffer[] = [];
  const limited = vi.fn();
  const closed = vi.fn();
  const link = SignalLink.attach(connection, (raw) => frames.push(raw), limited, closed)!;
  return { link, frames, limited, closed };
}

describe('SignalLink', () => {
  it('is null when the stream refuses the channel', () => {
    fake.refuse = true;
    expect(SignalLink.attach(connection, vi.fn(), vi.fn(), vi.fn())).toBeNull();
  });

  it('holds frames until the channel opens, in order, up to a limit', () => {
    const { link } = attach();
    const results = Array.from({ length: 20 }, (_, index) => link.send(frame(String(index))));
    expect(results.filter(Boolean)).toHaveLength(16);
    expect(fake.sent).toEqual([]);
    fake.opts!.onopen();
    expect(fake.sent.map(String)).toEqual(Array.from({ length: 16 }, (_, index) => String(index)));
  });

  it('forgets held frames and refuses more once closed', () => {
    const { link, closed } = attach();
    link.send(frame('held'));
    fake.opts!.onclose(true);
    expect(closed).toHaveBeenCalledOnce();
    expect(link.closed).toBe(true);
    expect(link.send(frame('late'))).toBe(false);
    expect(fake.sent).toEqual([]);
  });

  it('stops sending at the limit and resumes as it refills', () => {
    const { link } = attach();
    fake.opts!.onopen();
    for (let i = 0; i < SIGNAL_SEND_RATE.burst; i++) expect(link.send(frame('x'))).toBe(true);
    expect(link.send(frame('x'))).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(link.send(frame('x'))).toBe(true);
  });

  it('drops frames from a peer over its limit, and takes them again as it refills', () => {
    const { frames, limited } = attach();
    for (let i = 0; i < SIGNAL_RECEIVE_RATE.burst + 5; i++) fake.onmessage!(frame('x'));
    expect(frames).toHaveLength(SIGNAL_RECEIVE_RATE.burst);
    expect(limited).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(1000);
    fake.onmessage!(frame('x'));
    expect(frames).toHaveLength(SIGNAL_RECEIVE_RATE.burst + 1);
  });
});
