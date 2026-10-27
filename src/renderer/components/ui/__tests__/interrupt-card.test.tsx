import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InterruptCard, InterruptConfirm } from '../interrupt-card';

function Card(props: {
  busy?: boolean;
  queueSize?: number;
  onEscape?: () => void;
  onEnter?: () => void;
  aside?: React.ReactNode;
}) {
  return (
    <InterruptCard
      labelledBy="k"
      kickerId="k"
      kicker="Run command · terminal"
      queueSize={props.queueSize ?? 1}
      busy={props.busy}
      onEscape={props.onEscape ?? vi.fn()}
      onEnter={props.onEnter}
      aside={props.aside}
    >
      <p className="why">Why</p>
      <div className="wb-approve-actions">
        <button type="button" className="reject">
          Reject
        </button>
      </div>
    </InterruptCard>
  );
}

describe('InterruptCard', () => {
  it('is an alertdialog named by its kicker, with the queue count from 2 up', () => {
    const { rerender } = render(<Card />);
    const card = screen.getByRole('alertdialog', { name: 'Run command · terminal' });
    expect(card.className).toBe('wb-approve');
    expect(screen.queryByText('1 / 1')).toBeNull();
    rerender(<Card queueSize={3} />);
    expect(screen.getByText('1 / 3')).toBeTruthy();
    expect(screen.getByRole('alertdialog').className).toBe('wb-approve is-stack');
  });

  it('answers Escape and consumes it, so the thread does not stop the run', () => {
    const onEscape = vi.fn();
    const onWindow = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    window.addEventListener('keydown', onWindow);
    render(<Card onEscape={onEscape} />);
    fireEvent.keyDown(screen.getByText('Why'), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onWindow).toHaveReturnedWith(true);
    window.removeEventListener('keydown', onWindow);
  });

  it('ignores Escape and Enter while busy, but still consumes Escape', () => {
    const onEscape = vi.fn();
    const onEnter = vi.fn();
    const onWindow = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    window.addEventListener('keydown', onWindow);
    render(<Card busy onEscape={onEscape} onEnter={onEnter} />);
    fireEvent.keyDown(screen.getByText('Why'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByText('Why'), { key: 'Enter' });
    expect(onEscape).not.toHaveBeenCalled();
    expect(onEnter).not.toHaveBeenCalled();
    expect(onWindow).toHaveReturnedWith(true);
    window.removeEventListener('keydown', onWindow);
  });

  it('takes Enter as the default action except on a button', () => {
    const onEnter = vi.fn();
    render(<Card onEnter={onEnter} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reject' }), { key: 'Enter' });
    expect(onEnter).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByText('Why'), { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('answers Escape from the confirm beside the card', () => {
    const onEscape = vi.fn();
    render(
      <Card
        onEscape={onEscape}
        aside={
          <InterruptConfirm
            titleId="c"
            title="Always allow this command?"
            onCancel={vi.fn()}
            onConfirm={vi.fn()}
            confirmLabel="Always allow"
          />
        }
      />
    );
    const confirm = screen.getByRole('dialog', { name: 'Always allow this command?' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(confirm).toBeTruthy();
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});
