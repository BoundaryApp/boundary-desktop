import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIDENTIAL_COPY } from '../confidentialCopy';
import { PoolsHelpSheet } from '../PoolsHelpSheet';

const dialog = () => screen.getByRole('dialog', { name: 'How pools work' });

describe('PoolsHelpSheet', () => {
  afterEach(cleanup);

  it('renders nothing while closed', () => {
    render(<PoolsHelpSheet open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the sections in order', () => {
    render(<PoolsHelpSheet open onClose={vi.fn()} />);
    const headings = within(dialog())
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      'What providers still see',
      'Trust levels',
      'Which provider answers',
      'Private projects',
      'Accounts and billing',
      'When Boundary is closed',
    ]);
  });

  it('lists the three levels under Trust levels', () => {
    render(<PoolsHelpSheet open onClose={vi.fn()} />);
    const trust = screen.getByRole('heading', { name: 'Trust levels' }).closest('section') as HTMLElement;
    for (const level of ['A', 'B', 'C'] as const) {
      const row = within(trust).getByText(CONFIDENTIAL_COPY.levels[level].name).closest('li') as HTMLElement;
      expect(within(row).getByText(level)).toBeTruthy();
      expect(within(row).getByText(CONFIDENTIAL_COPY.levels[level].text)).toBeTruthy();
    }
  });

  it('says how long a failing provider is skipped, and names no model', () => {
    render(<PoolsHelpSheet open onClose={vi.fn()} />);
    expect(dialog().textContent).toContain('skipped for five minutes');
    expect(dialog().textContent).not.toContain('Qwen');
  });

  it('closes from Done', () => {
    const onClose = vi.fn();
    render(<PoolsHelpSheet open onClose={onClose} />);
    within(dialog()).getByRole('button', { name: 'Done' }).click();
    expect(onClose).toHaveBeenCalled();
  });
});
