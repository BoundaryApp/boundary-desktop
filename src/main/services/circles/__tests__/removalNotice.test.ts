import type { SecretStream } from 'hyperswarm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemovalLink } from '../removalNotice';

const fake = vi.hoisted(() => ({
  opts: null as null | { protocol: string; onopen(): void; onclose(isRemote: boolean): void },
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
          open: (): void => undefined,
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
const key = (index: number) => Buffer.from(String(index));

beforeEach(() => {
  fake.sent = [];
  fake.refuse = false;
});

describe('RemovalLink', () => {
  it('is null when the stream refuses the channel', () => {
    fake.refuse = true;
    expect(RemovalLink.attach(connection, vi.fn())).toBeNull();
  });

  it('opens the removal protocol and passes frames to the receiver', () => {
    const received: Buffer[] = [];
    RemovalLink.attach(connection, (circleKey) => received.push(circleKey));
    expect(fake.opts!.protocol).toBe('boundary/circle-removal/1');
    fake.onmessage!(key(1));
    expect(received.map(String)).toEqual(['1']);
  });

  it('holds 16 notices until the channel opens and drops the rest', () => {
    const link = RemovalLink.attach(connection, vi.fn())!;
    const results = Array.from({ length: 20 }, (_, index) => link.send(key(index)));
    expect(results).toEqual([...Array(16).fill(true), ...Array(4).fill(false)]);
    expect(fake.sent).toEqual([]);
    fake.opts!.onopen();
    expect(fake.sent.map(String)).toEqual(Array.from({ length: 16 }, (_, index) => String(index)));
  });

  it('sends without a cap once open', () => {
    const link = RemovalLink.attach(connection, vi.fn())!;
    fake.opts!.onopen();
    for (let i = 0; i < 20; i++) expect(link.send(key(i))).toBe(true);
    expect(fake.sent).toHaveLength(20);
  });

  it('forgets held notices and refuses more once closed', () => {
    const link = RemovalLink.attach(connection, vi.fn())!;
    link.send(key(1));
    fake.opts!.onclose(true);
    expect(link.send(key(2))).toBe(false);
    expect(fake.sent).toEqual([]);
  });
});
