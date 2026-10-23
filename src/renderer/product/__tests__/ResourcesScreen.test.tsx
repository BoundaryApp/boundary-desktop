import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComposeInventorySnapshot } from '../../../shared/types/composeInventory';
import type { HostResourceSnapshot } from '../../../shared/types/hostResources';
import { ComposeInventoryView, ResourcesView } from '../ResourcesScreen';

function gib(n: number): number {
  return n * 1024 * 1024 * 1024;
}

function fixture(overrides: Partial<HostResourceSnapshot['buckets']> = {}): HostResourceSnapshot {
  return {
    collectedAt: '2026-09-25T12:00:00.000Z',
    host: {
      displayName: 'This Mac',
      cpuCores: 10,
      memoryBytes: gib(32),
      diskBytes: gib(512),
    },
    buckets: {
      app: {
        id: 'app',
        cpuShare: 0.04,
        memoryBytes: gib(0.8),
        diskBytes: gib(2.1),
        status: 'measured',
        detail: 'Electron main and renderers',
      },
      stack: {
        id: 'stack',
        cpuShare: 0.11,
        memoryBytes: gib(4.2),
        diskBytes: gib(18.4),
        status: 'measured',
        detail: 'boundary-assistant · running',
      },
      llm: {
        id: 'llm',
        cpuShare: 0,
        memoryBytes: 0,
        diskBytes: gib(42),
        status: 'not-detected',
        detail: 'not detected',
      },
      rest: {
        id: 'rest',
        cpuShare: 0.85,
        memoryBytes: gib(27),
        diskBytes: gib(449.5),
        status: 'estimated',
        detail: 'Estimated · includes free disk',
      },
      ...overrides,
    },
    caveats: ['Disk is capacity, not I/O. GPU is out of this cut.'],
  };
}

describe('ResourcesView', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders not-detected LLM and estimated rest from a fixture', () => {
    render(<ResourcesView snapshot={fixture()} error={null} />);
    expect(screen.getByRole('heading', { name: 'Resources' })).toBeTruthy();
    expect(screen.getByText('not detected')).toBeTruthy();
    expect(screen.getByText('Estimated · includes free disk')).toBeTruthy();
    expect(screen.getByText(/estimated/)).toBeTruthy();
    expect(screen.getByLabelText('CPU share of host')).toBeTruthy();
  });

  it('shows an error without inventing bars', () => {
    render(<ResourcesView snapshot={null} error="Could not read host resources." />);
    expect(screen.getByText('Could not read host resources.')).toBeTruthy();
    expect(screen.queryByLabelText('CPU share of host')).toBeNull();
  });

  it('renders observe-only Compose inventory under the meters', () => {
    const inventory: ComposeInventorySnapshot = {
      engineRunning: true,
      projects: [
        {
          id: 'boundary',
          name: 'boundary-assistant',
          status: 'running',
          path: '/Users/me/assistant',
          services: [
            { name: 'hermes', status: 'running', ports: ['127.0.0.1:8642'] },
            { name: 'searxng', status: 'running', ports: ['8080'] },
          ],
        },
      ],
    };
    render(<ResourcesView snapshot={fixture()} error={null} inventory={inventory} />);
    const list = screen.getByLabelText('Compose on this machine');
    expect(list.textContent).toContain('boundary-assistant');
    expect(list.textContent).toContain('running');
    expect(list.textContent).toContain('2 services');
    expect(screen.queryByRole('button', { name: /start|stop|restart/i })).toBeNull();
  });
});

describe('ComposeInventoryView', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows engine-down honesty without inventing projects', () => {
    render(
      <ComposeInventoryView inventory={{ engineRunning: false, projects: [] }} />
    );
    expect(screen.getByText(/Engine is not running/)).toBeTruthy();
    expect(screen.queryByText('boundary-assistant')).toBeNull();
  });

  it('shows empty-host honesty when the engine is up', () => {
    render(
      <ComposeInventoryView inventory={{ engineRunning: true, projects: [] }} />
    );
    expect(screen.getByText(/No Compose projects on this host/)).toBeTruthy();
  });
});
