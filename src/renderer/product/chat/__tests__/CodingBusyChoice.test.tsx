import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodingBusyButtons, CodingBusyWarning } from '../CodingBusyChoice';

describe('CodingBusyChoice', () => {
  it('names the running tasks and what the change does', () => {
    render(
      <CodingBusyWarning
        agent={{ busy: true, sessions: ['Fix tests'] }}
        verb="allow"
        look="popover"
      />
    );
    expect(
      screen.getByText(/A coding task is running \(Fix tests\)\. Allowing coding restarts/)
    ).toBeTruthy();
  });

  it('passes the chosen mode, and shows a queued change as waiting', () => {
    const onChoose = vi.fn();
    const { rerender } = render(<CodingBusyButtons verb="add" look="sheet" onChoose={onChoose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop task and add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add when it finishes' }));
    expect(onChoose.mock.calls).toEqual([['stop'], ['queue']]);

    rerender(<CodingBusyButtons verb="add" look="interrupt" onChoose={onChoose} queued disabled />);
    const waiting = screen.getByRole('button', { name: 'Waiting for it to finish…' });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);
  });
});
