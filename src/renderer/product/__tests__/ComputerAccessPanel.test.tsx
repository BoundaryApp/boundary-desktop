import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import type { HostBridgeGrant } from '../../../shared/types/hostBridge';
import { ComputerAccessPanel, describeGrant } from '../ComputerAccessPanel';

const grants: HostBridgeGrant[] = [
  { capability: 'notify', resource: '*', createdAt: '2026-10-08T10:00:00Z', expiresAt: null },
  { capability: 'open_url', resource: 'linkedin.com', createdAt: '2026-10-08T10:00:00Z', expiresAt: null },
  { capability: 'read_file', resource: '/Users/me/data/report.csv', createdAt: '2026-10-08T10:00:00Z', expiresAt: '2026-10-09T10:00:00Z' },
];

let hostBridge: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  hostBridge = {
    listGrants: vi.fn(async () => grants),
    revokeGrant: vi.fn(async (grant: HostBridgeGrant) => grants.filter((g) => g.capability !== grant.capability)),
    revokeAllGrants: vi.fn(async () => []),
    agentStopped: vi.fn(async (stopped?: boolean) => ({ stopped: stopped ?? false })),
    rotateTokens: vi.fn(async () => ({ success: true })),
  };
  stubElectronAPI({ hostBridge });
});

afterEach(() => cleanup());

describe('describeGrant', () => {
  it('says in plain words what each grant lets Hermes do', () => {
    expect(describeGrant(grants[0]).label).toBe('Show desktop notifications');
    expect(describeGrant(grants[1]).label).toBe('Open linkedin.com pages in your browser');
    expect(describeGrant(grants[2])).toEqual({ label: 'Read report.csv', detail: '/Users/me/data/report.csv' });
  });
});

describe('ComputerAccessPanel', () => {
  it('lists grants and revokes one or all', async () => {
    render(<ComputerAccessPanel />);
    expect(await screen.findByText('Open linkedin.com pages in your browser')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke: Show desktop notifications' }));
    await screen.findByText('Read report.csv');
    expect(hostBridge.revokeGrant).toHaveBeenCalledWith(grants[0]);
    expect(screen.queryByText('Show desktop notifications')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke all' }));
    expect(await screen.findByText('Nothing is always allowed. Hermes asks each time.')).toBeTruthy();
  });
});

describe('Stop agent', () => {
  it('stops the agent, shows that it is stopped, and turns access back on', async () => {
    render(<ComputerAccessPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop agent' }));
    expect(await screen.findByText(/Agent stopped\. Hermes can’t/)).toBeTruthy();
    expect(hostBridge.agentStopped).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole('button', { name: 'Stop agent' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Turn access back on' }));
    expect(await screen.findByRole('button', { name: 'Stop agent' })).toBeTruthy();
    expect(hostBridge.agentStopped).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText(/Agent stopped/)).toBeNull();
  });

  it('opens stopped when the agent was stopped before', async () => {
    hostBridge.agentStopped.mockResolvedValueOnce({ stopped: true });
    render(<ComputerAccessPanel />);
    expect(await screen.findByRole('button', { name: 'Turn access back on' })).toBeTruthy();
    expect(hostBridge.agentStopped).toHaveBeenCalledWith();
  });

  it('says so when access is back on but the bridge did not start', async () => {
    hostBridge.agentStopped
      .mockResolvedValueOnce({ stopped: true })
      .mockResolvedValueOnce({ stopped: false, error: 'Host bridge did not start in time.' });
    render(<ComputerAccessPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn access back on' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/did not start in time/);
  });
});

describe('Replace tokens', () => {
  it('shows it is working, then that the new tokens are in use', async () => {
    let finish!: (result: { success: boolean }) => void;
    hostBridge.rotateTokens.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    render(<ComputerAccessPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace tokens' }));
    const button = await screen.findByRole('button', { name: 'Replacing…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Stop agent' }) as HTMLButtonElement).disabled).toBe(true);

    finish({ success: true });
    expect(await screen.findByText('New tokens are in use. The old ones no longer work.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Replace tokens' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says what failed', async () => {
    hostBridge.rotateTokens.mockResolvedValueOnce({
      success: false,
      error: 'Hermes didn’t get the new tokens: Assistant stack is not ready.',
    });
    render(<ComputerAccessPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace tokens' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Hermes didn’t get the new tokens/);
    expect(screen.queryByText(/New tokens are in use/)).toBeNull();
  });

  it('is hidden while the agent is stopped, since Stop agent already rotated them', async () => {
    hostBridge.agentStopped.mockResolvedValueOnce({ stopped: true });
    render(<ComputerAccessPanel />);
    await screen.findByRole('button', { name: 'Turn access back on' });
    expect(screen.queryByRole('button', { name: 'Replace tokens' })).toBeNull();
  });

  it('says so when access is back on but Hermes did not get the new tokens', async () => {
    hostBridge.agentStopped
      .mockResolvedValueOnce({ stopped: true })
      .mockResolvedValueOnce({ stopped: false, hermesError: 'No configured LLM connection to apply.' });
    render(<ComputerAccessPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn access back on' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Hermes didn’t get the new tokens: No configured LLM/);
  });
});

describe('when main fails', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function flush() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it('says Stop agent failed and leaves the button to try again', async () => {
    hostBridge.agentStopped
      .mockResolvedValueOnce({ stopped: false })
      .mockRejectedValueOnce(new Error('store write failed'));
    render(<ComputerAccessPanel />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Stop agent' }));
    await flush();

    expect(screen.getByRole('alert').textContent).toBe('Couldn’t stop the agent: store write failed');
    expect((screen.getByRole('button', { name: 'Stop agent' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says a revoke failed and keeps the grant listed', async () => {
    hostBridge.revokeGrant.mockRejectedValueOnce(new Error('store write failed'));
    render(<ComputerAccessPanel />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke: Show desktop notifications' }));
    await flush();

    expect(screen.getByRole('alert').textContent).toBe('Couldn’t revoke: store write failed');
    expect(screen.getByText('Show desktop notifications')).toBeTruthy();
  });
});
