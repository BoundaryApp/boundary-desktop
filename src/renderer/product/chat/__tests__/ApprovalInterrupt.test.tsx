import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HermesChatApprovalEvent } from '../../../../shared/types/hermesChat';
import { ApprovalInterrupt } from '../ApprovalInterrupt';

function event(
  overrides: Partial<HermesChatApprovalEvent> = {}
): HermesChatApprovalEvent {
  return {
    rpcRequestId: 'rpc-1',
    sessionId: 'sess-1',
    approvalRequestId: 'apr-1',
    command: 'rm -rf applications/scratch',
    toolName: 'terminal',
    choices: ['once', 'session', 'always', 'deny'],
    ...overrides,
  };
}

describe('ApprovalInterrupt', () => {
  afterEach(() => {
    cleanup();
  });

  it('offers Run and Reject, not a flat once/session/always row', () => {
    const onRespond = vi.fn();
    render(
      <ApprovalInterrupt approval={event()} queueSize={1} onRespond={onRespond} />
    );

    expect(screen.getByRole('button', { name: /Run/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Once' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Session' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Always' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Run/ }));
    expect(onRespond).toHaveBeenCalledWith('once');
  });

  it('hides More when the gateway only sent once and deny', () => {
    render(
      <ApprovalInterrupt
        approval={event({ choices: ['once', 'deny'], smartDenied: true })}
        queueSize={1}
        onRespond={() => undefined}
      />
    );

    expect(screen.getByText(/Reviewer flagged/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('confirms Always allow before sending', () => {
    const onRespond = vi.fn();
    render(
      <ApprovalInterrupt approval={event()} queueSize={1} onRespond={onRespond} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Always allow/ }));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /Always allow this command/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    expect(onRespond).toHaveBeenCalledWith('always');
  });

  it('shows 1 of N when more approvals are queued', () => {
    render(
      <ApprovalInterrupt approval={event()} queueSize={2} onRespond={() => undefined} />
    );
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  it('sends deny from Reject', () => {
    const onRespond = vi.fn();
    render(
      <ApprovalInterrupt approval={event()} queueSize={1} onRespond={onRespond} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onRespond).toHaveBeenCalledWith('deny');
  });

  it('shows a calendar write as the event, with only Add event and Don’t add', () => {
    const onRespond = vi.fn();
    render(
      <ApprovalInterrupt
        approval={event({
          command: "MCP tool 'caldav_create_event' on UNTRUSTED server 'calendar-personal' wants to run",
          toolName: undefined,
          choices: ['once', 'session', 'deny'],
          mcp: {
            server: 'calendar-personal',
            tool: 'caldav_create_event',
            arguments: { summary: 'Call with Jordan', start: '2026-10-23T11:00:00', calendar_name: 'Work' },
          },
        })}
        queueSize={1}
        onRespond={onRespond}
      />
    );

    expect(screen.getByText('Add an event')).toBeTruthy();
    expect(screen.getByText('Call with Jordan')).toBeTruthy();
    expect(screen.getByText('Personal › Work')).toBeTruthy();
    expect(screen.queryByText(/UNTRUSTED/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Don’t add' }));
    expect(onRespond).toHaveBeenCalledWith('deny');
    fireEvent.click(screen.getByRole('button', { name: /Add event/ }));
    expect(onRespond).toHaveBeenCalledWith('once');
  });

  it('uses the generic card for a calendar call it can’t describe', () => {
    render(
      <ApprovalInterrupt
        approval={event({
          choices: ['once', 'deny'],
          mcp: { server: 'calendar-personal', tool: 'caldav_create_event', arguments: { surprise: 'x' } },
        })}
        queueSize={1}
        onRespond={() => undefined}
      />
    );
    expect(screen.getByRole('button', { name: /Run/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });
});
