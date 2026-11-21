import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PasswordField } from '../password-field';

describe('PasswordField', () => {
  it('hides the password until shown, and passes input props through', () => {
    const onChange = vi.fn();
    const ref = React.createRef<HTMLInputElement>();
    render(
      <>
        <label htmlFor="pw">Password</label>
        <PasswordField id="pw" ref={ref} className="font-mono" value="" onChange={onChange} />
      </>
    );
    const input = screen.getByLabelText('Password') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.dataset.slot).toBe('input');
    expect(input.classList.contains('font-mono')).toBe(true);
    expect(input.classList.contains('pr-9')).toBe(true);
    expect(ref.current).toBe(input);

    fireEvent.change(input, { target: { value: 'secret' } });
    expect(onChange).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input.type).toBe('password');
  });

  it('does not submit its form when the toggle is pressed', () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordField aria-label="Password" />
      </form>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
