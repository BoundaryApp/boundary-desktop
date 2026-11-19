import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERRORS_ON_CLIPBOARD, type ReportContext } from '../../../../shared/bugReport';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { BugReportSheet } from '../BugReportSheet';

const context: ReportContext = {
  environment: { appVersion: '1.0.0-rc.16', os: 'macOS 26.0', chip: 'Apple silicon' },
  errors: [
    {
      time: '2026-11-08T09:12:04.000Z',
      area: 'calendar',
      name: 'CalendarSyncError',
      message: '502 from https://[host]/dav',
      frames: [],
    },
  ],
  redactions: [
    { kind: 'host', shown: 'mail.example.com' },
    { kind: 'key', shown: 'sk-or-••••••••' },
  ],
};

const writeText = vi.fn(async (_text: string) => undefined);

function setup(overrides: { collect?: () => Promise<ReportContext> } = {}) {
  const api = stubElectronAPI({
    bugReport: {
      collect: vi.fn(overrides.collect ?? (async () => context)),
      save: vi.fn(async () => ({ success: true, saved: true })),
    },
    urls: { openUrl: vi.fn(async () => ({ success: true })) },
  });
  const onClose = vi.fn();
  render(<BugReportSheet screen="Chat" onClose={onClose} />);
  return { api, onClose };
}

async function describeAndContinue(what = 'Calendar sync fails.') {
  await act(async () => undefined);
  fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: what } });
  fireEvent.change(screen.getByLabelText('What did you expect?'), { target: { value: 'Events show up.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

const openedUrl = (api: ReturnType<typeof setup>['api']) =>
  new URL(String(api.urls.openUrl.mock.calls.at(-1)?.[0]));

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

describe('BugReportSheet', () => {
  it('needs a description before Review', async () => {
    setup();
    await act(async () => undefined);
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Last 10 minutes, private details removed · 1 error found/)).toBeTruthy();
  });

  it('drafts the issue from what the user wrote and what Boundary collected', async () => {
    setup();
    await describeAndContinue();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Calendar sync fails');
    const body = (screen.getByLabelText('Issue text') as HTMLTextAreaElement).value;
    expect(body).toContain('## What happened\nCalendar sync fails.');
    expect(body).toContain('## What I expected\nEvents show up.');
    expect(body).toContain('Boundary 1.0.0-rc.16 · macOS 26.0 · Apple silicon · Chat screen');
    expect(body).toContain('CalendarSyncError: 502 from https://[host]/dav');
    expect(screen.getByText('Fits in the link to GitHub.')).toBeTruthy();
    expect(screen.getByText(/GitHub issues are public/)).toBeTruthy();
  });

  it('shows what it removed when asked', async () => {
    setup();
    await describeAndContinue();
    expect(screen.getByText('Removed before you saw this: 2 private details')).toBeTruthy();
    expect(screen.queryByText('mail.example.com')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show what changed' }));
    expect(screen.getByText('mail.example.com')).toBeTruthy();
    expect(screen.getByText('sk-or-••••••••')).toBeTruthy();
  });

  it('leaves out what the user turned off', async () => {
    setup();
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('switch', { name: 'App details' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Recent errors' }));
    await describeAndContinue();
    const body = (screen.getByLabelText('Issue text') as HTMLTextAreaElement).value;
    expect(body).not.toContain('## Environment');
    expect(body).not.toContain('## Recent errors');
    expect(screen.queryByText(/Removed before you saw this/)).toBeNull();
  });

  it('opens the text edited in Review, then hands off', async () => {
    const { api } = setup();
    await describeAndContinue();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Calendar sync fails twice' } });
    fireEvent.change(screen.getByLabelText('Issue text'), { target: { value: 'My own words.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open in GitHub' }));
    });
    const url = openedUrl(api);
    expect(url.pathname).toBe('/BoundaryApp/boundary-desktop/issues/new');
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('title')).toBe('Calendar sync fails twice');
    expect(url.searchParams.get('report')).toBe('My own words.');
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Finish in your browser' })).toBeTruthy();
    expect(screen.getByText('Press Submit')).toBeTruthy();
    expect(screen.queryByText(/sent/i, { selector: 'h2' })).toBeNull();
  });

  it('copies the errors when the report is too long for a link, keeping the description', async () => {
    const many = { ...context, errors: Array.from({ length: 80 }, () => context.errors[0]) };
    const { api } = setup({ collect: async () => many });
    await describeAndContinue();
    expect(screen.getByText(/Too long for a link. Boundary copies the errors/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open in GitHub' }));
    });
    const report = openedUrl(api).searchParams.get('report') ?? '';
    expect(report).toContain('## What happened\nCalendar sync fails.');
    expect(report).toContain(ERRORS_ON_CLIPBOARD);
    expect(writeText.mock.calls[0]?.[0]).toContain('CalendarSyncError');
    expect(screen.getByText('Paste the errors into the issue')).toBeTruthy();
  });

  it('copies and saves the report', async () => {
    const { api } = setup();
    await describeAndContinue();
    fireEvent.click(screen.getByRole('button', { name: 'Copy report' }));
    await act(async () => undefined);
    expect(writeText.mock.calls[0]?.[0]).toMatch(/^# Calendar sync fails\n\n## What happened/);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save as file…' }));
    });
    expect(api.bugReport.save).toHaveBeenCalledWith({
      title: 'Calendar sync fails',
      body: expect.stringContaining('## What happened'),
    });
    expect(screen.getByText('Saved.')).toBeTruthy();
  });

  it('still reports when the log cannot be read', async () => {
    const { api } = setup({ collect: async () => Promise.reject(new Error('no log')) });
    await describeAndContinue();
    expect((screen.getByLabelText('Issue text') as HTMLTextAreaElement).value).toBe(
      '## What happened\nCalendar sync fails.\n\n## What I expected\nEvents show up.'
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open in GitHub' }));
    });
    expect(api.urls.openUrl).toHaveBeenCalled();
  });

  it('stays on Review and says why when the browser does not open', async () => {
    const { api } = setup();
    api.urls.openUrl.mockResolvedValue({ success: false, error: 'No browser.' });
    await describeAndContinue();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open in GitHub' }));
    });
    expect(screen.getByText('No browser.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Report a bug' })).toBeTruthy();
  });

  it('closes on Escape before any sheet underneath', async () => {
    const underneath = vi.fn();
    window.addEventListener('keydown', underneath);
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(underneath).not.toHaveBeenCalled();
    window.removeEventListener('keydown', underneath);
  });
});
