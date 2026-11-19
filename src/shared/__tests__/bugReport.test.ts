import { describe, expect, it } from 'vitest';
import {
  ERRORS_HEADING,
  ERRORS_ON_CLIPBOARD,
  REPORT_ON_CLIPBOARD,
  composeReportBody,
  draftTitle,
  fitReportLink,
  issueLink,
  reportAsText,
  type ReportContext,
} from '../bugReport';

const context: ReportContext = {
  environment: { appVersion: '1.0.0-rc.16', os: 'macOS 26.0', chip: 'Apple silicon' },
  errors: [
    {
      time: '2026-11-08T09:12:04.120Z',
      area: 'calendar',
      name: 'CalendarSyncError',
      message: '502 from [host]',
      frames: ['syncCalendars (src/main/services/assistant/calendar/calendarService.ts:196)'],
    },
  ],
  redactions: [{ kind: 'host', shown: 'mail.example.com' }],
};

const draft = {
  what: 'Calendar sync fails.',
  expected: 'Events show up.',
  screen: 'Chat',
  includeApp: true,
  includeErrors: true,
  context,
};

const reportParam = (url: string) => new URL(url).searchParams.get('report');

describe('composeReportBody', () => {
  it('writes the description, expectation, environment and errors', () => {
    expect(composeReportBody(draft)).toBe(
      [
        '## What happened\nCalendar sync fails.',
        '## What I expected\nEvents show up.',
        '## Environment\nBoundary 1.0.0-rc.16 · macOS 26.0 · Apple silicon · Chat screen',
        `${ERRORS_HEADING}\n\`\`\`\n09:12:04 calendar  CalendarSyncError: 502 from [host]\n    at syncCalendars (src/main/services/assistant/calendar/calendarService.ts:196)\n\`\`\``,
      ].join('\n\n')
    );
  });

  it('leaves out what the user turned off', () => {
    const body = composeReportBody({ ...draft, expected: ' ', includeApp: false, includeErrors: false });
    expect(body).toBe('## What happened\nCalendar sync fails.');
  });

  it('says when there were no errors', () => {
    const body = composeReportBody({ ...draft, context: { ...context, errors: [] } });
    expect(body).toContain(`${ERRORS_HEADING}\nNone in the last 10 minutes.`);
  });
});

describe('draftTitle', () => {
  it('uses the first line without a closing period', () => {
    expect(draftTitle('Search finds nothing.\nEven for words I can see.')).toBe('Search finds nothing');
  });

  it('cuts a long line at a word', () => {
    const title = draftTitle(`${'word '.repeat(40)}end`);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith('word…')).toBe(true);
  });
});

describe('issueLink', () => {
  it('fills the issue form by its field id', () => {
    const url = new URL(issueLink('Search fails', 'Body & more\n## x'));
    expect(url.origin + url.pathname).toBe('https://github.com/BoundaryApp/boundary-desktop/issues/new');
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('title')).toBe('Search fails');
    expect(url.searchParams.get('report')).toBe('Body & more\n## x');
    expect(url.searchParams.has('labels')).toBe(false);
  });
});

describe('fitReportLink', () => {
  it('keeps a short report whole', () => {
    const body = composeReportBody(draft);
    const link = fitReportLink('Title', body);
    expect(link).toMatchObject({ moved: 'none', clipboard: null });
    expect(reportParam(link.url)).toBe(body);
  });

  it('keeps text edited in Review', () => {
    const edited = `${composeReportBody(draft)}\n\nI edited this.`;
    expect(reportParam(fitReportLink('Title', edited).url)).toBe(edited);
  });

  it('moves the errors to the clipboard and keeps the description', () => {
    const long = { ...context, errors: Array.from({ length: 80 }, () => context.errors[0]) };
    const body = composeReportBody({ ...draft, context: long });
    const link = fitReportLink('Title', body);
    expect(link.moved).toBe('errors');
    expect(link.url.length).toBeLessThanOrEqual(6_000);
    const sent = reportParam(link.url) ?? '';
    expect(sent).toContain('## What happened\nCalendar sync fails.');
    expect(sent).toContain('## Environment');
    expect(sent).toContain(`${ERRORS_HEADING}\n${ERRORS_ON_CLIPBOARD}`);
    expect(sent).not.toContain('CalendarSyncError');
    expect(link.clipboard?.startsWith('```\n09:12:04 calendar')).toBe(true);
  });

  it('keeps sections after the errors in the link', () => {
    const long = { ...context, errors: Array.from({ length: 80 }, () => context.errors[0]) };
    const body = `${composeReportBody({ ...draft, context: long })}\n\n## Notes\nAfter.`;
    expect(reportParam(fitReportLink('Title', body).url)).toContain('\n## Notes\nAfter.');
  });

  it('moves the whole text when the description alone is too long', () => {
    const body = composeReportBody({ ...draft, what: 'x'.repeat(7_000) });
    const link = fitReportLink('Title', body);
    expect(link).toMatchObject({ moved: 'all', clipboard: body });
    expect(reportParam(link.url)).toBe(REPORT_ON_CLIPBOARD);
  });
});

describe('reportAsText', () => {
  it('puts the title above the text', () => {
    expect(reportAsText(' Title ', 'Body\n')).toBe('# Title\n\nBody\n');
  });
});
