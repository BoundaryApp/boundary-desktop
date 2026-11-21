import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { AgentBrowserPanel } from '../AgentBrowserPanel';
import { CalendarsPanel } from '../CalendarsPanel';
import { ComputerAccessPanel } from '../ComputerAccessPanel';
import { WebSearchModeSection } from '../WebSearchModeSection';
import { calendarsApi, openSignIn, reportProgress, stubCalendars } from './calendarsHarness';

// ADR 0023 §8: Settings panels name the built-in agent from its stored record, not a literal.
const agents = [
  { slug: 'assistant', displayName: 'Hob', handle: 'hob', role: '', builtIn: true, createdAt: '' },
];
const agentsApi = { list: vi.fn() };

beforeEach(() => {
  agentsApi.list.mockReset().mockResolvedValue({ success: true, agents, standingDmByAgent: {} });
});

describe('Settings panels name the built-in agent from its record', () => {
  it('Agent browser', async () => {
    stubElectronAPI({
      agents: agentsApi,
      hostBridge: {
        getBrowserState: vi.fn(async () => ({
          settings: { enabled: true, blocked: null, allowed: [] },
          effectiveBlocked: [],
          defaultBlocked: [],
          chromeInstalled: true,
          running: true,
          clients: 1,
        })),
      },
      assistantStack: { getWebSearchMode: vi.fn(async () => ({ mode: 'private', canChange: false, overrides: [] })) },
    });
    render(<AgentBrowserPanel />);
    expect(await screen.findByText('Hob browses here, with the logins you add.')).toBeTruthy();
    expect(screen.getByText('Open. Hob is using it now.')).toBeTruthy();
  });

  it('Computer access', async () => {
    stubElectronAPI({
      agents: agentsApi,
      hostBridge: {
        listGrants: vi.fn(async () => []),
        agentStopped: vi.fn(async () => ({ stopped: false })),
      },
    });
    render(<ComputerAccessPanel />);
    expect(await screen.findByText('Nothing is always allowed. Hob asks each time.')).toBeTruthy();
  });

  it('Web search', async () => {
    stubElectronAPI({
      agents: agentsApi,
      assistantStack: { getWebSearchMode: vi.fn(async () => ({ mode: 'private', canChange: true, overrides: [] })) },
    });
    render(<WebSearchModeSection />);
    await screen.findByRole('radio', { name: /Private only/ });
    fireEvent.click(screen.getByRole('button', { name: /web search/i, description: undefined }));
    expect(await screen.findByText(/Who answers Hob’s web searches/)).toBeTruthy();
    // The engine's own restart wording stays.
    expect(screen.getByRole('button', { name: 'Save and restart Hermes' })).toBeTruthy();
  });

  it('Calendars', async () => {
    stubCalendars();
    stubElectronAPI({ agents: agentsApi });
    calendarsApi.test.mockResolvedValue({ status: 'ok', url: 'https://caldav.icloud.com/', calendars: [] });
    calendarsApi.connect.mockReturnValue(new Promise(() => undefined));
    await openSignIn();
    fireEvent.change(screen.getByLabelText('App-specific password'), { target: { value: 'abcd-efgh-ijkl-mnop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test sign-in' }));
    await screen.findByText(/Signed in/);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    act(() => reportProgress({ slug: 'personal', step: 'checking' }));
    expect(await screen.findByText('Checking Hob can read it')).toBeTruthy();
  });
});
