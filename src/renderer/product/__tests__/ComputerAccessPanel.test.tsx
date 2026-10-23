import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { hostBridge };
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
