import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from '../switch';

describe('Switch', () => {
  it('is named by its label and reports the next state', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} label="Check for updates" onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'Check for updates' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.className).toBe('wb-switch');
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('marks the on state and turns off', () => {
    const onChange = vi.fn();
    render(<Switch checked label="Camera" onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'Camera' });
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(control.className).toBe('wb-switch is-on');
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('does nothing while disabled', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} label="Tools" disabled onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'Tools' }) as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    fireEvent.click(control);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('can be named by another element or a wrapping label', () => {
    render(
      <>
        <span id="camera-label">Camera</span>
        <Switch checked={false} labelledBy="camera-label" onChange={vi.fn()} />
        <label>
          Tools
          <Switch checked={false} onChange={vi.fn()} />
        </label>
      </>
    );
    expect(screen.getByRole('switch', { name: 'Camera' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Tools' })).toBeTruthy();
  });

  it('keeps a caller look in place of wb-switch', () => {
    render(<Switch checked label="Mute" className="wb-circle-switch" onChange={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Mute' }).className).toBe('wb-circle-switch is-on');
  });
});
