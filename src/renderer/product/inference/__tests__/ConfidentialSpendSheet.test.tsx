import React from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConfidentialSpend,
  ConfidentialSpendRow,
} from '../../../../shared/types/confidentialState';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { ConfidentialSpendSheet } from '../ConfidentialSpendSheet';

function row(overrides: Partial<ConfidentialSpendRow>): ConfidentialSpendRow {
  return {
    providerId: 'near',
    name: 'NEAR AI Cloud',
    level: 'B',
    turns: 312,
    turnsWithoutCounts: 0,
    inputTokens: 1_200_000,
    outputTokens: 840_000,
    cost: 1.98,
    balance: 2.1,
    removed: false,
    ...overrides,
  };
}

function spend(rows: ConfidentialSpendRow[]): ConfidentialSpend {
  return {
    since: 0,
    rows,
    totalTurns: rows.reduce((sum, r) => sum + r.turns, 0),
    totalCost: rows.reduce((sum, r) => sum + r.cost, 0),
  };
}

async function mount(result: ConfidentialSpend | null, open = true) {
  const getSpend = vi.fn().mockResolvedValue(result);
  stubElectronAPI({ confidential: { getSpend } });
  const view = render(<ConfidentialSpendSheet open={open} onClose={vi.fn()} />);
  await act(async () => undefined);
  return { getSpend, view };
}

const dialog = () =>
  screen.getByRole('dialog', { name: 'Spend, last 30 days' });
const rowOf = (name: string) =>
  within(dialog()).getByText(name).closest('tr') as HTMLElement;

describe('ConfidentialSpendSheet', () => {
  afterEach(cleanup);

  it('lists the rows in the order given with a total', async () => {
    await mount(
      spend([
        row({}),
        row({
          providerId: 'prem',
          name: 'Prem',
          level: 'A',
          turns: 41,
          inputTokens: 950,
          outputTokens: 3_100,
          cost: 0.61,
          balance: 18.4,
        }),
      ]),
    );
    const bodyRows = within(dialog()).getAllByRole('row');
    expect(bodyRows[1].textContent).toContain('NEAR AI Cloud');
    expect(bodyRows[2].textContent).toContain('Prem');
    const near = within(rowOf('NEAR AI Cloud'));
    expect(near.getByText('312')).toBeTruthy();
    expect(near.getByText('1.2M')).toBeTruthy();
    expect(near.getByText('840K')).toBeTruthy();
    expect(near.getByText('$1.98')).toBeTruthy();
    expect(near.getByText('$2.10')).toBeTruthy();
    const prem = within(rowOf('Prem'));
    expect(prem.getByText('950')).toBeTruthy();
    expect(prem.getByText('3.1K')).toBeTruthy();
    const total = within(rowOf('Total'));
    expect(total.getByText('353')).toBeTruthy();
    expect(total.getByText('$2.59')).toBeTruthy();
  });

  it('reads Removed and Not reported in the balance cell', async () => {
    await mount(
      spend([
        row({ removed: true, balance: null }),
        row({ providerId: 'prem', name: 'Prem', balance: null }),
      ]),
    );
    expect(within(rowOf('NEAR AI Cloud')).getByText('Removed')).toBeTruthy();
    expect(within(rowOf('Prem')).getByText('Not reported')).toBeTruthy();
  });

  it('reads a tiny cost as under $0.01', async () => {
    await mount(spend([row({ cost: 0.000126 })]));
    expect(
      within(rowOf('NEAR AI Cloud')).getByText('under $0.01'),
    ).toBeTruthy();
  });

  it('shows the note, and the no-counts line only when turns lacked counts', async () => {
    await mount(spend([row({ turnsWithoutCounts: 2 })]));
    expect(
      within(dialog()).getByText(
        /Boundary counts the tokens each reply reports/,
      ),
    ).toBeTruthy();
    expect(
      within(dialog()).getByText(
        '2 turns reported no token counts and aren’t in the estimate.',
      ),
    ).toBeTruthy();
    cleanup();
    await mount(spend([row({ turnsWithoutCounts: 0 })]));
    expect(within(dialog()).queryByText(/reported no token counts/)).toBeNull();
  });

  it('shows the empty line when the added providers have no turns', async () => {
    // What main returns with one provider added and nothing recorded: a zero row.
    await mount(
      spend([
        row({
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          balance: 2.1,
        }),
      ]),
    );
    expect(
      within(dialog()).getByText('No turns in the last 30 days.'),
    ).toBeTruthy();
    expect(within(dialog()).queryByRole('table')).toBeNull();
  });

  it('clears the last numbers on close, so a reopen waits for fresh ones', async () => {
    const { getSpend, view } = await mount(spend([row({})]));
    expect(within(rowOf('NEAR AI Cloud')).getByText('312')).toBeTruthy();
    view.rerender(<ConfidentialSpendSheet open={false} onClose={vi.fn()} />);
    await act(async () => undefined);
    let answer!: (value: ConfidentialSpend) => void;
    getSpend.mockReturnValueOnce(
      new Promise<ConfidentialSpend>((resolve) => (answer = resolve)),
    );
    view.rerender(<ConfidentialSpendSheet open onClose={vi.fn()} />);
    await act(async () => undefined);
    expect(within(dialog()).queryByRole('table')).toBeNull();
    expect(within(dialog()).queryByText('312')).toBeNull();
    await act(async () => answer(spend([row({ turns: 313 })])));
    expect(within(rowOf('NEAR AI Cloud')).getByText('313')).toBeTruthy();
  });

  it('fetches once per open, not while closed', async () => {
    const { getSpend, view } = await mount(spend([row({})]), false);
    expect(getSpend).not.toHaveBeenCalled();
    view.rerender(<ConfidentialSpendSheet open onClose={vi.fn()} />);
    await act(async () => undefined);
    expect(getSpend).toHaveBeenCalledTimes(1);
    view.rerender(<ConfidentialSpendSheet open onClose={vi.fn()} />);
    await act(async () => undefined);
    expect(getSpend).toHaveBeenCalledTimes(1);
  });
});
