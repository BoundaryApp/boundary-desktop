import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('../chromePipe', () => ({ ChromePipe: { launch } }));

const { BrowserRelay } = await import('../browserRelay');

describe('BrowserRelay credential client (ADR 0065)', () => {
  it("is refused while Chrome isn't open, and never starts it", async () => {
    const relay = new BrowserRelay(
      { enabled: true, chrome: { chromePath: '/nonexistent/Chrome', profileDir: '/nonexistent/profile' }, policy: { blocked: [], allowed: [] } },
      vi.fn()
    );
    await expect(relay.handleUpgrade({} as IncomingMessage, new PassThrough(), Buffer.alloc(0), 'credentials')).rejects.toThrow(
      /isn't open/
    );
    expect(launch).not.toHaveBeenCalled();
    await relay.close();
  });
});
