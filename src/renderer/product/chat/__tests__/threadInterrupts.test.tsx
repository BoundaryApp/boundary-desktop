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

describe('ThreadInterrupts in the desktop panel (ADR 0058 §14)', () => {
  afterEach(() => cleanup());

  const codingAccess = {
    ...quiet(null),
    codingAccess: {
      request: {
        id: 'c1',
        sessionId: 's-1',
        requestId: 'r1',
        hostPath: '/Users/me/code/site',
        name: 'site',
        exists: true,
        isGit: true,
        projectId: null,
        projectFolderId: null,
      },
      queueSize: 1,
      resolve: vi.fn(),
    },
  } as unknown as ChatInterrupts;

  it('shows a line that opens a folder request in the app window, since it does not fit 384 pixels', () => {
    const open = vi.fn();
    render(<ThreadInterrupts interrupts={codingAccess} projects={[]} onFollowUp={vi.fn()} onOpenInWindow={open} />);
    expect(screen.getByText(/wants to work in a folder/)).toBeTruthy();
    expect(screen.queryByText('/Users/me/code/site')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Answer in Boundary’s window' }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('draws an approval in place, since it fits', () => {
    const approval = {
      ...quiet(null),
      approval: { sessionId: 's-1', command: 'ls', description: 'List files', choices: ['once', 'deny'] },
      chatApprovals: [{}],
    } as unknown as ChatInterrupts;
    render(<ThreadInterrupts interrupts={approval} projects={[]} onFollowUp={vi.fn()} onOpenInWindow={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Answer in Boundary’s window' })).toBeNull();
  });
});
