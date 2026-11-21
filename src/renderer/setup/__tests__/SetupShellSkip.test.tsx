import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const skipStep = vi.fn().mockResolvedValue(undefined);
const setup = {
  activeStep: { id: 'llm-onboarding', optional: true, skipLabel: 'Set up later' },
  skipStep: (...args: unknown[]) => skipStep(...args),
};

vi.mock('../SetupContext', () => ({ useSetup: () => setup, useOptionalSetup: () => setup }));
vi.mock('../SetupBackgroundStatus', () => ({ SetupBackgroundStatus: (): null => null }));
vi.mock('../../experiments', () => ({ rendererExperiments: [] }));

import { SetupShell } from '../SetupShell';

describe('SetupShell on the Model step', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers Set up later and records it as a skip', async () => {
    render(
      <SetupShell title="Choose a model" description="Pick where replies come from.">
        {null}
      </SetupShell>
    );
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Set up later' }));
    await waitFor(() => expect(skipStep).toHaveBeenCalledWith('llm-onboarding'));
  });

  it('places the buttons right after the content, inside the scrolling area', () => {
    const { container } = render(
      <SetupShell title="Choose a model" actions={<button type="button">Continue</button>}>
        <p>Step body</p>
      </SetupShell>
    );
    const main = screen.getByRole('main');
    // A <footer> inside <main> has no landmark role, so find it by tag.
    const footer = container.querySelector('footer') as HTMLElement;
    expect(main.contains(footer)).toBe(true);
    expect(footer.className).toContain('sticky');
    const body = screen.getByText('Step body');
    expect(body.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(footer.contains(screen.getByRole('button', { name: 'Continue' }))).toBe(true);
  });
});
