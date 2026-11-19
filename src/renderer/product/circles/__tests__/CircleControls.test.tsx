import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar, CircleButton, initials, keyHue } from '../CircleControls';

describe('CircleButton', () => {
  it.each(['page', 'row'] as const)('renders a solid button with the solid look at size %s', (size) => {
    render(
      <CircleButton variant="primary" size={size}>
        Invite someone
      </CircleButton>
    );
    expect(screen.getByRole('button', { name: 'Invite someone' }).className).toContain('wb-btn-solid');
  });
});

describe('Avatar', () => {
  it('shows up to two initials, and says the status dot', () => {
    expect(initials('Maya Chen Ortiz')).toBe('MC');
    expect(initials(' bo ')).toBe('BO');
    expect(initials('Maya')).toBe('MA');
    render(<Avatar name="Maya Chen" dot="bg-ok" label="Online" />);
    expect(screen.getByRole('img', { name: 'Online' })).toBeTruthy();
    expect(screen.getByText('MC')).toBeTruthy();
  });

  it('colours a person by their key, so two people with one name differ', () => {
    expect(keyHue('aa'.repeat(32))).toBe(keyHue('aa'.repeat(32)));
    expect(keyHue('aa'.repeat(32))).not.toBe(keyHue('bb'.repeat(32)));
    render(<Avatar name="Sam" seed={'aa'.repeat(32)} />);
    expect((screen.getByText('SA').parentElement as HTMLElement).style.background).not.toBe('');
  });
});
