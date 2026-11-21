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
    expect(control.dataset.slot).toBe('switch');
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('marks the on state and turns off', () => {
    const onChange = vi.fn();
    render(<Switch checked label="Camera" onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'Camera' });
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(control.dataset.slot).toBe('switch');
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

  it('merges a layout class instead of replacing the look', () => {
    render(<Switch checked label="Mute" className="ml-auto" onChange={vi.fn()} />);
    const control = screen.getByRole('switch', { name: 'Mute' });
    expect(control.className).toBe('ml-auto');
    expect(control.dataset.slot).toBe('switch');
    expect(control.getAttribute('aria-checked')).toBe('true');
  });
});
