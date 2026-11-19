import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { poolBridge, poolState } from '../../../__tests__/confidentialFixtures';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { resetIpcStoresForTests } from '../../../lib/ipcStore';
import { CONFIDENTIAL_COPY } from '../confidentialCopy';
import { PoolDetails } from '../PoolDetails';

async function mount(props: React.ComponentProps<typeof PoolDetails> = { modelId: 'qwen' }) {
  const confidential = poolBridge();
  stubElectronAPI({ confidential });
  render(<PoolDetails {...props} />);
  await act(async () => undefined);
  return confidential;
}

const list = (name: string) => within(screen.getByRole('list', { name }));

describe('PoolDetails', () => {
  beforeEach(() => resetIpcStoresForTests());

  it('lists who serves, cheapest first, with prices and a cost a turn', async () => {
    await mount();
    const serving = list('Who serves, cheapest first').getAllByRole('listitem');
    expect(serving.map((row) => row.querySelector('b')?.textContent)).toEqual(['NEAR AI Cloud', 'Prem']);
    expect(serving[0].textContent).toContain('$0.200 in · $2.00 out per million · cached $0.05');
    expect(serving[0].textContent).toContain('$0.012a turn');
    expect(screen.getByText(CONFIDENTIAL_COPY.turnNote)).toBeTruthy();
  });

  it('says why each other provider isn’t used', async () => {
    await mount();
    const out = list('Not used').getByRole('listitem');
    expect(out.textContent).toContain('Chutes');
    expect(out.textContent).toContain('Not added. Pools only use providers you add.');
  });

  it('shows the settings the pool follows, and opens Pool settings', async () => {
    await mount();
    expect(screen.getByText('B · Hardware checked')).toBeTruthy();
    expect(screen.getByText('fp8, or not stated')).toBeTruthy();
    expect(screen.getByText('Level A or better')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pool settings' }));
    expect(screen.getByRole('dialog', { name: 'Pool settings' })).toBeTruthy();
  });

  it('ranks for a private project, and again when the pool’s state changes', async () => {
    const confidential = await mount({ modelId: 'qwen', privateProject: true, projectFloor: 'B' });
    expect(confidential.rank).toHaveBeenCalledWith({ modelId: 'qwen', privateProject: true, projectFloor: 'B' });
    const calls = confidential.rank.mock.calls.length;
    const listener = (window.electronAPI.confidential.onState as unknown as { mock: { calls: [(s: unknown) => void][] } })
      .mock.calls[0][0];
    await act(async () => listener(poolState()));
    expect(confidential.rank.mock.calls.length).toBeGreaterThan(calls);
  });

  it('closes Pool settings and opens the help sheet from its How pools work link', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Pool settings' }));
    await act(async () => undefined);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Pool settings' })).getByRole('button', { name: 'How pools work' }));
    expect(screen.queryByRole('dialog', { name: 'Pool settings' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'How pools work' })).toBeTruthy();
  });

  it('shows a placeholder, not an error, while the ranking loads', async () => {
    const confidential = poolBridge();
    confidential.rank.mockReturnValue(new Promise(() => undefined));
    stubElectronAPI({ confidential });
    render(<PoolDetails modelId="qwen" />);
    await act(async () => undefined);
    expect(screen.getByText('Finding who serves it…')).toBeTruthy();
    expect(screen.queryByText(/can serve now/)).toBeNull();
  });
});
