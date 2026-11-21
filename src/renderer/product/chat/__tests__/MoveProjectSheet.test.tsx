import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { poolBridge } from '../../../__tests__/confidentialFixtures';
import { resetIpcStoresForTests } from '../../../lib/ipcStore';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import { MoveProjectSheet } from '../MoveProjectSheet';

const project = (id: string, inference: HermesProjectRecord['inference']): HermesProjectRecord => ({
  id,
  name: id,
  hostPath: `/Users/ada/${id}`,
  containerPath: `/opt/projects/${id}`,
  slug: id,
  kind: 'host-folder',
  inference,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
});

/** The app default is the Qwen pool; one project pins Local, the other inherits. */
const status = {
  configured: true,
  encryptionAvailable: true,
  appDefault: 'local' as const,
  appSharedModel: { slot: 'confidential' as const, modelId: 'qwen' },
  slots: { local: { configured: true, modelId: 'qwen3:14b', health: 'reachable' as const } },
};

describe('MoveProjectSheet', () => {
  beforeEach(() => {
    resetIpcStoresForTests();
    stubElectronAPI({
      onboarding: { getStatus: vi.fn().mockResolvedValue(status), onStatus: () => () => {} },
      hermesChat: { getSessionInference: vi.fn().mockResolvedValue({ override: null }) },
      projects: { countSources: vi.fn().mockResolvedValue(0) },
      confidential: poolBridge(),
    });
  });
  afterEach(() => {
    stubElectronAPI({ confidential: { getState: vi.fn(() => new Promise<never>(() => undefined)) } });
    resetIpcStoresForTests();
  });

  it('names a pool the chat moves to by its model', async () => {
    render(
      <MoveProjectSheet
        target={{ sessionIds: ['s1'], label: '“Plans”', fromProjectId: 'pinned' }}
        projects={[project('pinned', { mode: 'local', modelId: 'qwen3:14b' }), project('inherits', { mode: 'inherit' })]}
        agentName="Marlow"
        onMove={() => {}}
        onCancel={() => {}}
      />
    );
    expect(await screen.findByText(/Inference moves to the cloud: Confidential · Qwen 3\.8 27B\./)).toBeTruthy();
  });
});

const base: HermesProjectRecord = {
  id: 'p1',
  name: 'Job Search',
  hostPath: '/Users/ada/Documents/Job Search',
  containerPath: '/opt/projects/job-search',
  slug: 'job-search',
  kind: 'host-folder',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
};
const projects: HermesProjectRecord[] = [
  base,
  { ...base, id: 'p2', name: 'Notes', slug: 'notes', hostPath: '/Users/ada/Notes' },
  { ...base, id: 'p3', name: 'Site', slug: 'site', hostPath: '/Users/ada/Site' },
];

function renderSheet(fromProjectId: string | null, onMove = vi.fn()) {
  render(
    <MoveProjectSheet
      target={{ sessionIds: ['s1'], label: '“Plan”', fromProjectId }}
      projects={projects}
      agentName="Marlow"
      onMove={onMove}
      onCancel={vi.fn()}
    />
  );
  return onMove;
}

const selected = () =>
  screen
    .getAllByRole('option')
    .filter((o) => o.getAttribute('aria-selected') === 'true')
    .map((o) => o.textContent);

describe('MoveProjectSheet destination list', () => {
  afterEach(() => {
    cleanup();
  });

  it('is one Tab stop whose arrows select, skipping the current project', () => {
    const onMove = renderSheet('p2');
    const list = screen.getByRole('listbox', { name: 'Destination' });
    expect(list.tabIndex).toBe(0);
    for (const option of screen.getAllByRole('option')) {
      expect(option.hasAttribute('tabindex')).toBe(false);
    }
    expect(selected()[0]).toMatch(/Job Search/);
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0].id);

    fireEvent.keyDown(list, { key: 'ArrowDown' });
    // Notes is where the chat is now, so the arrow lands on Site.
    expect(selected()[0]).toMatch(/Site/);
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[2].id);

    fireEvent.keyDown(list, { key: 'End' });
    expect(selected()[0]).toMatch(/No project/);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(selected()[0]).toMatch(/Job Search/);

    fireEvent.click(screen.getByRole('button', { name: 'Move to Job Search' }));
    expect(onMove).toHaveBeenCalledWith('p1');
  });

  it('picks by click and leaves the current project disabled', () => {
    const onMove = renderSheet('p1');
    const current = screen.getByRole('option', { name: /Job Search/ });
    expect(current.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(current);
    expect(selected()[0]).toMatch(/Notes/);
    fireEvent.click(screen.getByRole('option', { name: /No project/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to No project' }));
    expect(onMove).toHaveBeenCalledWith(null);
  });
});
