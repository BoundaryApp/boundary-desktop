import { describe, expect, it } from 'vitest';
import { CircleNetwork } from '../circleNetwork';

/**
 * The harness for net tests can't give one identity two devices in a Circle, so which device a
 * call tunnel goes to is pinned here against a network with only the fields the choice reads.
 */

const KEY = 'aa'.repeat(32);
const ME = 'a1'.repeat(32);
const BO = 'b2'.repeat(32);
const FIRST = 'c3'.repeat(32);
const SECOND = 'd4'.repeat(32);
const OTHER = 'e5'.repeat(32);

function network(connected: string[]) {
  const opened: string[] = [];
  const net = Object.create(CircleNetwork.prototype) as Record<string, unknown>;
  net.identity = { publicKey: Buffer.from(ME, 'hex') };
  net.circles = new Map([
    [
      KEY,
      {
        state: {
          members: [
            { identity: ME, device: 'f6'.repeat(32) },
            { identity: BO, device: FIRST },
            { identity: BO, device: SECOND },
            { identity: 'a9'.repeat(32), device: OTHER },
          ],
        },
      },
    ],
  ]);
  net.peers = new Map(connected.map((device) => [device, {}]));
  net.tunnels = {
    open: async (device: string): Promise<number> => {
      opened.push(device);
      return 40_000;
    },
    count: (): number => opened.length,
  };
  net.diag = (): void => undefined;
  net.startTunnelSampler = (): void => undefined;
  return { net: net as unknown as CircleNetwork, opened };
}

describe('openCallTunnel device', () => {
  it('opens to the first connected device when none is given', async () => {
    const { net, opened } = network([SECOND]);
    await net.openCallTunnel(KEY, BO, 7);
    expect(opened).toEqual([SECOND]);
  });

  it('opens to the given device even when another of theirs is connected and listed first', async () => {
    const { net, opened } = network([FIRST, SECOND]);
    await net.openCallTunnel(KEY, BO, 7, SECOND);
    expect(opened).toEqual([SECOND]);
  });

  it("refuses a device that isn't theirs", async () => {
    const { net, opened } = network([FIRST, SECOND, OTHER]);
    await expect(net.openCallTunnel(KEY, BO, 7, OTHER)).rejects.toThrow("That device isn't theirs.");
    await expect(net.openCallTunnel(KEY, BO, 7, 'ff'.repeat(32))).rejects.toThrow("That device isn't theirs.");
    expect(opened).toEqual([]);
  });

  it('refuses a device that is theirs but not connected', async () => {
    const { net, opened } = network([FIRST]);
    await expect(net.openCallTunnel(KEY, BO, 7, SECOND)).rejects.toThrow('No connection to that member.');
    expect(opened).toEqual([]);
  });
});
