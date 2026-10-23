import { describe, expect, it } from 'vitest';
import { hostToolsStateFor, nextExpectedClients } from '../hostToolsState';

const SOON = false;
const LATER = true;

describe('hostToolsStateFor', () => {
  it('waits for as many Hermes clients as connected last launch', () => {
    expect(hostToolsStateFor(0, 4, SOON)).toBe('waiting');
    expect(hostToolsStateFor(1, 4, SOON)).toBe('waiting');
    expect(hostToolsStateFor(3, 4, SOON)).toBe('waiting');
    expect(hostToolsStateFor(4, 4, SOON)).toBe('connected');
  });

  it('settles once every parked process has had its retry', () => {
    expect(hostToolsStateFor(2, 4, LATER)).toBe('connected');
    // No count from a previous launch: only the settle time can say.
    expect(hostToolsStateFor(3, 0, SOON)).toBe('waiting');
    expect(hostToolsStateFor(3, 0, LATER)).toBe('connected');
  });

  it('never says connected before any Hermes client has listed the tools', () => {
    expect(hostToolsStateFor(0, 0, LATER)).toBe('waiting');
  });
});

describe('nextExpectedClients', () => {
  it('only grows before the launch settles, then takes its count', () => {
    expect(nextExpectedClients(4, 1, SOON)).toBe(4);
    expect(nextExpectedClients(4, 5, SOON)).toBe(5);
    expect(nextExpectedClients(4, 3, LATER)).toBe(3);
    expect(nextExpectedClients(4, 0, LATER)).toBe(4);
  });
});
