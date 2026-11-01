import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar, CircleButton, initials } from '../CircleControls';

afterEach(() => cleanup());

describe('CircleButton', () => {
  it.each(['page', 'row'] as const)('keeps a solid button’s text colour at size %s', (size) => {
    render(
      <CircleButton variant="default" size={size}>
        Invite someone
      </CircleButton>
    );
    expect(screen.getByRole('button', { name: 'Invite someone' }).className).toContain('text-solid-fg');
  });
});

describe('Avatar', () => {
  it('shows up to two initials, and says the status dot', () => {
    expect(initials('Maya Chen Ortiz')).toBe('MC');
    expect(initials(' bo ')).toBe('B');
    render(<Avatar name="Maya Chen" dot="bg-ok" label="Online" />);
    expect(screen.getByRole('img', { name: 'Online' })).toBeTruthy();
    expect(screen.getByText('MC')).toBeTruthy();
  });
});
