import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MakeRoomCancelled,
  makeRoomFor,
  pendingEngineFloorMiB,
  pendingReservationsMiB,
  releasePendingReservation,
  type MakeRoomDeps,
} from '../engineMakeRoom';

function fakeDeps(over: Partial<MakeRoomDeps> = {}) {
  const order: string[] = [];
  const deps: MakeRoomDeps = {
    engineResizable: vi.fn(async () => true),
    announce: vi.fn((message: string) => void order.push(`announce:${message}`)),
    stopStack: vi.fn(async () => void order.push('stopStack')),
    stopMachine: vi.fn(async () => void order.push('stopMachine')),
    startStack: vi.fn(async () => {
      // The start reads the reservation to size the machine.
      order.push(`startStack:${JSON.stringify(pendingReservationsMiB())}`);
      return { success: true };
    }),
    ...over,
  };
  return { deps, order };
}

describe('makeRoomFor', () => {
  afterEach(() => releasePendingReservation('twenty'));

  it('stops the stack and machine, then starts them with the reservation counted', async () => {
    const { deps, order } = fakeDeps();
    await makeRoomFor('twenty', 'Twenty CRM', 2208, 8192, deps);
    expect(order).toEqual([
      'announce:Making room for Twenty CRM…',
      'stopStack',
      'stopMachine',
      'startStack:{"twenty":2208}',
    ]);
    // Kept until the install ends, so a restart during the install keeps the size.
    expect(pendingReservationsMiB()).toEqual({ twenty: 2208 });
    expect(pendingEngineFloorMiB()).toBe(8192);
  });

  it('refuses an engine Boundary can\'t resize, without stopping anything', async () => {
    const { deps, order } = fakeDeps({ engineResizable: async () => false });
    await expect(makeRoomFor('twenty', 'Twenty CRM', 2208, 8192, deps)).rejects.toThrow(/can't resize this engine/);
    expect(order).toEqual([]);
    expect(pendingReservationsMiB()).toEqual({});
  });

  it('can be cancelled before anything stops', async () => {
    const { deps, order } = fakeDeps();
    const run = new AbortController();
    run.abort();
    await expect(makeRoomFor('twenty', 'Twenty CRM', 2208, 8192, deps, run.signal)).rejects.toBeInstanceOf(MakeRoomCancelled);
    expect(order).toEqual([]);
  });

  it('starts again at the old size when the start at the new size fails', async () => {
    const { deps, order } = fakeDeps();
    vi.mocked(deps.startStack)
      .mockImplementationOnce(async () => {
        order.push(`startStack:${JSON.stringify(pendingReservationsMiB())}`);
        return { success: false, error: 'machine set failed' };
      });
    await expect(makeRoomFor('twenty', 'Twenty CRM', 2208, 8192, deps)).rejects.toThrow(
      /back at its old size\. machine set failed/
    );
    expect(order.slice(-2)).toEqual(['startStack:{"twenty":2208}', 'startStack:{}']);
    expect(pendingReservationsMiB()).toEqual({});
    expect(pendingEngineFloorMiB()).toBe(0);
  });

  it('starts the stack again when stopping fails', async () => {
    const { deps, order } = fakeDeps({
      stopMachine: async () => {
        throw new Error('machine did not stop');
      },
    });
    await expect(makeRoomFor('twenty', 'Twenty CRM', 2208, 8192, deps)).rejects.toThrow(/machine did not stop/);
    expect(order.at(-1)).toBe('startStack:{}');
  });
});
