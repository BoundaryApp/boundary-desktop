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
});
