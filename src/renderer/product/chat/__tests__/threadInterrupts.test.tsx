import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostToolsState } from '../../../../shared/types/hostBridge';
import { ThreadInterrupts } from '../ThreadInterrupts';
import type { ChatInterrupts } from '../useChatInterrupts';

const settings = vi.hoisted(() => ({ openSettings: vi.fn() }));
vi.mock('../../settingsNavigation', () => settings);

const quiet = (hostTools: HostToolsState | null) =>
  ({
    approval: null,
    chatApprovals: [],
    credentialRequest: null,
    credentialRequests: [],
    savedLogin: null,
    hostApprovals: { approval: null },
    codingAccess: { request: null },
    hostTools,
  }) as unknown as ChatInterrupts;

describe('ThreadInterrupts host-tools note', () => {
  afterEach(() => cleanup());

  it('says computer access is stopped and opens its settings', () => {
    render(<ThreadInterrupts interrupts={quiet('stopped')} projects={[]} onFollowUp={vi.fn()} />);
    expect(
      screen.getByText(/Computer access is stopped\. Turn it back on in Settings → Computer access\./)
    ).toBeTruthy();
    expect(screen.queryByText(/Restart Boundary/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Computer access' }));
    expect(settings.openSettings).toHaveBeenCalledWith({ tab: 'access' });
  });

  it('still asks for a restart when the tools are off for another reason', () => {
    render(<ThreadInterrupts interrupts={quiet('off')} projects={[]} onFollowUp={vi.fn()} />);
    expect(screen.getByText(/Restart Boundary to try again/)).toBeTruthy();
  });
});
