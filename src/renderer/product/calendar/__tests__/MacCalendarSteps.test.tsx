import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MacCalendarSummary } from '../../../../shared/types/calendars';
import { MacChooseStep, defaultTicked } from '../MacCalendarSteps';

const calendars: MacCalendarSummary[] = [
  { id: 'a', title: 'Garden', color: '#336699', source: 'iCloud', kind: 'icloud', writable: true },
  { id: 'b', title: 'Birthdays', color: '#999999', source: 'iCloud', kind: 'birthdays', writable: false },
  { id: 'c', title: 'Tides', color: '#669933', source: 'Subscribed', kind: 'subscribed', writable: false },
  { id: 'd', title: 'Club', color: '#993366', source: 'Other', kind: 'caldav', writable: true },
];

describe('MacCalendarSteps', () => {
  it('ticks every calendar except Birthdays and subscribed ones by default', () => {
    expect(defaultTicked(calendars)).toEqual(['a', 'd']);
  });

  it('keeps the ticked ids in the Mac’s order and shows each swatch', () => {
    const onChange = vi.fn();
    render(<MacChooseStep calendars={calendars} ticked={['d']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Garden/ }));
    expect(onChange).toHaveBeenCalledWith(['a', 'd']);
    const swatch = screen.getByRole('checkbox', { name: /Club/ }).parentElement?.querySelector('.wb-cal-mac-swatch') as HTMLElement;
    // Compare with the DOM's own spelling of the Mac's colour: Chromium reads it back as
    // rgb(...), happy-dom as the hex it was given.
    const expected = document.createElement('span');
    expected.style.background = '#993366';
    expect(swatch.style.background).toBe(expected.style.background);
  });

  it('asks for at least one calendar when none is ticked', () => {
    render(<MacChooseStep calendars={calendars} ticked={[]} onChange={vi.fn()} />);
    expect(screen.getByText('Tick at least one calendar.')).toBeTruthy();
  });
});
