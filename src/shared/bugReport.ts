/**
 * Bug reports (bug report spec): what a report holds and how it becomes a pre-filled GitHub
 * issue link. Main collects the errors and app details; the renderer composes and opens.
 */

/** Where a report link points. Phase 6 makes this a build-time setting. */
const REPORT_REPO = 'BoundaryApp/boundary-desktop';

/** The issue form in `.github/ISSUE_TEMPLATE`, and its one text field. */
const REPORT_TEMPLATE = 'bug_report.yml';
const REPORT_FIELD = 'report';

/**
 * Longest link Boundary opens. GitHub returned 500 for links just over 7,000 characters on
 * 8 Nov 2026 and publishes no limit; a signed-in browser also sends larger headers, so this
 * leaves room.
 */
const REPORT_LINK_LIMIT = 6_000;

export const REPORT_TITLE_MAX = 120;

export const ERRORS_HEADING = '## Recent errors';

export interface ReportEnvironment {
  appVersion: string;
  /** e.g. "macOS 26.0". */
  os: string;
  /** e.g. "Apple silicon". */
  chip: string;
}

/** One error from the debug log, reduced to the allowlisted fields and redacted. */
export interface ReportError {
  /** ISO time. */
  time: string;
  area: string;
  message: string;
  name?: string;
  /** Top stack frames, paths reduced to repo-relative form. */
  frames: string[];
}

export type RedactionKind = 'path' | 'key' | 'host' | 'account';

/** One thing the collector removed, for Review's list. `shown` masks keys. */
export interface ReportRedaction {
  kind: RedactionKind;
  shown: string;
}

export interface ReportContext {
  environment: ReportEnvironment;
  errors: ReportError[];
  redactions: ReportRedaction[];
}

export interface ReportDraftInput {
  what: string;
  expected: string;
  /** The screen the user was on, e.g. "Chat". */
  screen: string;
  includeApp: boolean;
  includeErrors: boolean;
  context: ReportContext | null;
}

/** A title from the description's first line, for the user to edit in Review. */
export function draftTitle(what: string): string {
  const line = what.trim().split('\n')[0]?.trim() ?? '';
  if (line.length <= REPORT_TITLE_MAX) return line.replace(/[.\s]+$/, '');
  const cut = line.slice(0, REPORT_TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[,.;:\s]+$/, '')}…`;
}

function time(iso: string): string {
  const match = /T(\d\d:\d\d:\d\d)/.exec(iso);
  return match ? match[1] : iso;
}

/** The errors as plain lines, newest last. */
export function formatReportErrors(errors: ReportError[]): string {
  return errors
    .map((error) => {
      const head = `${time(error.time)} ${error.area}  ${error.name ? `${error.name}: ` : ''}${error.message}`;
      return [head, ...error.frames.map((frame) => `    at ${frame}`)].join('\n');
    })
    .join('\n');
}

/** The issue text Review starts from. */
export function composeReportBody(input: ReportDraftInput): string {
  const sections = [`## What happened\n${input.what.trim()}`];
  if (input.expected.trim()) sections.push(`## What I expected\n${input.expected.trim()}`);
  if (input.includeApp && input.context) {
    const { appVersion, os, chip } = input.context.environment;
    sections.push(`## Environment\nBoundary ${appVersion} · ${os} · ${chip} · ${input.screen} screen`);
  }
  if (input.includeErrors && input.context) {
    const errors = input.context.errors;
    sections.push(
      errors.length
        ? `${ERRORS_HEADING}\n\`\`\`\n${formatReportErrors(errors)}\n\`\`\``
        : `${ERRORS_HEADING}\nNone in the last 10 minutes.`
    );
  }
  return sections.join('\n\n');
}

/** The text Copy report and Save as file give: the title, then the issue text. */
export function reportAsText(title: string, body: string): string {
  return `# ${title.trim()}\n\n${body.trim()}\n`;
}

export function issueLink(title: string, body: string, repo = REPORT_REPO): string {
  const params = new URLSearchParams({ template: REPORT_TEMPLATE, title: title.trim(), [REPORT_FIELD]: body });
  // URLSearchParams writes spaces as "+", which GitHub reads as spaces in both fields.
  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}

export interface ReportLink {
  url: string;
  /** Text to put on the clipboard before opening, when part of the report didn't fit. */
  clipboard: string | null;
  /** What left the link: nothing, the errors section, or the whole issue text. */
  moved: 'none' | 'errors' | 'all';
}

export const ERRORS_ON_CLIPBOARD = 'Boundary copied the errors to the clipboard. Paste them here.';
export const REPORT_ON_CLIPBOARD = 'Boundary copied the report to the clipboard. Paste it here.';

/** The errors section of `body`: from its heading to the next heading or the end. */
function errorsSection(body: string): { start: number; end: number } | null {
  const start = body.indexOf(ERRORS_HEADING);
  if (start < 0) return null;
  const next = body.indexOf('\n## ', start + ERRORS_HEADING.length);
  return { start, end: next < 0 ? body.length : next };
}

/**
 * The link for this title and text. A text too long for the link moves the errors section to
 * the clipboard first, keeping the description in the link; if that is still too long, the
 * whole text moves.
 */
export function fitReportLink(
  title: string,
  body: string,
  { repo = REPORT_REPO, limit = REPORT_LINK_LIMIT }: { repo?: string; limit?: number } = {}
): ReportLink {
  const full = issueLink(title, body, repo);
  if (full.length <= limit) return { url: full, clipboard: null, moved: 'none' };
  const section = errorsSection(body);
  if (section) {
    const errors = body.slice(section.start, section.end).trim();
    const rest = `${body.slice(0, section.start)}${ERRORS_HEADING}\n${ERRORS_ON_CLIPBOARD}${body.slice(section.end)}`;
    const url = issueLink(title, rest, repo);
    if (url.length <= limit) {
      return { url, clipboard: errors.slice(ERRORS_HEADING.length).trim(), moved: 'errors' };
    }
  }
  return { url: issueLink(title, REPORT_ON_CLIPBOARD, repo), clipboard: body, moved: 'all' };
}
