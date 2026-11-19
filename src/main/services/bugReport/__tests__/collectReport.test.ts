import { describe, expect, it } from 'vitest';
import { composeReportBody, formatReportErrors } from '../../../../shared/bugReport';
import { collectReportContext, errorFromLogLine, normaliseFrame, recentErrors } from '../collectReport';
import { redactReportText, type ReportIdentity } from '../redactReport';

const NOW = Date.parse('2026-11-08T09:20:00.000Z');
const identity: ReportIdentity = { home: '/Users/sam', host: 'Sams-MacBook-Pro.local', user: 'sam' };

const CHAT = 'Pull the train times out of my trip notes';
const SECRET = 'sk-or-v1-0123456789abcdef0123456789abcdef';

const line = (ts: string, area: string, message: string, data: Record<string, unknown> = {}) =>
  JSON.stringify({ ts, sessionId: 's', pid: 1, area, message, data });

const fixtureLog = [
  line('2026-11-08T09:00:00.000Z', 'session', 'debug session start', { cwd: '/Users/sam/code', argv: [CHAT] }),
  // Older than ten minutes.
  line('2026-11-08T09:05:00.000Z', 'calendar', 'sync failed', { name: 'CalendarSyncError' }),
  // Not an error.
  line('2026-11-08T09:11:00.000Z', 'startup', 'window shown', { prompt: CHAT }),
  line('2026-11-08T09:12:04.000Z', 'calendar', 'sync failed', {
    name: 'CalendarSyncError',
    message: `502 from https://mail.example.com/dav for sam@example.com with key ${SECRET}`,
    stack: [
      'CalendarSyncError: 502',
      '    at syncCalendars (/Users/sam/Documents/Work/boundary/src/main/services/assistant/calendar/calendarService.ts:196:11)',
      '    at file:///Applications/Boundary.app/Contents/Resources/app.asar/.vite/build/index.js:4410:7',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n'),
    stderr: `the agent said: ${CHAT}`,
    stdout: CHAT,
    reply: CHAT,
  }),
  line('2026-11-08T09:15:00.000Z', 'hermes', 'gateway request timed out', {
    errorName: 'GatewayTimeout',
    url: 'http://Sams-MacBook-Pro.local:8642/v1/runs',
    text: CHAT,
  }),
  '{"ts": "2026-11-08T09:16:00.000Z", "area": "cut off by a cr',
].join('\n');

describe('errorFromLogLine', () => {
  it('copies only the allowlisted fields', () => {
    const error = errorFromLogLine(fixtureLog.split('\n')[3]);
    expect(Object.keys(error ?? {}).sort()).toEqual(['area', 'frames', 'message', 'name', 'time']);
  });

  it('skips lines that are not errors, and broken lines', () => {
    expect(errorFromLogLine(line('2026-11-08T09:11:00.000Z', 'startup', 'window shown'))).toBeNull();
    expect(errorFromLogLine('{"ts":')).toBeNull();
  });
});

describe('normaliseFrame', () => {
  it('reduces paths to repo-relative form', () => {
    expect(normaliseFrame('at f (/Users/sam/x/boundary/src/main/a.ts:1:2)')).toBe('f (src/main/a.ts:1:2)');
    expect(normaliseFrame('at file:///A/app.asar/.vite/build/index.js:4:7')).toBe('.vite/build/index.js:4:7');
    expect(normaliseFrame('at g (/opt/other/thing.js:3:1)')).toBe('g (thing.js:3:1)');
    expect(normaliseFrame('at node:internal/process/task_queues:95:5')).toBe('node:internal/process/task_queues:95:5');
  });
});

describe('recentErrors', () => {
  it('keeps the last ten minutes', () => {
    expect(recentErrors(fixtureLog, NOW).map((error) => error.time)).toEqual([
      '2026-11-08T09:12:04.000Z',
      '2026-11-08T09:15:00.000Z',
    ]);
  });
});

describe('collectReportContext', () => {
  const context = collectReportContext({
    readLog: () => fixtureLog,
    environment: () => ({ appVersion: '1.0.0', os: 'macOS 26.0', chip: 'Apple silicon' }),
    identity: () => identity,
    now: () => NOW,
  });
  const report = composeReportBody({
    what: 'Sync fails',
    expected: '',
    screen: 'Chat',
    includeApp: true,
    includeErrors: true,
    context,
  });

  it('leaves no secret, home path, host, account or chat text in the report', () => {
    for (const text of [SECRET, '/Users/sam', 'mail.example.com', 'Sams-MacBook-Pro', 'sam@example.com', CHAT]) {
      expect(report).not.toContain(text);
    }
    expect(report).not.toMatch(/\bsam\b/);
  });

  it('keeps what a developer needs', () => {
    expect(formatReportErrors(context.errors)).toBe(
      [
        '09:12:04 calendar  CalendarSyncError: sync failed: 502 from https://[host]/dav for [account] with key [key]',
        '    at syncCalendars (src/main/services/assistant/calendar/calendarService.ts:196:11)',
        '    at .vite/build/index.js:4410:7',
        '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
        '09:15:00 hermes  GatewayTimeout: gateway request timed out',
      ].join('\n')
    );
  });

  it('lists what it removed, with keys masked', () => {
    expect(context.redactions).toEqual([
      { kind: 'account', shown: 'sam@example.com' },
      { kind: 'key', shown: 'sk-or-••••••••' },
      { kind: 'host', shown: 'mail.example.com' },
    ]);
  });
});

describe('redactReportText', () => {
  it('removes paths, hosts and keys of every kind it knows', () => {
    const { text, removed } = redactReportText(
      [
        'open /Users/alex/Documents/Trips failed',
        'home /home/alex/.config',
        'Authorization: Bearer abc.def.ghi-123',
        'token=hunter22',
        'ghp_0123456789abcdefABCDEF0123',
        'peer 192.168.1.20 and 127.0.0.1',
        'printer.lan said no',
        'host Sams-MacBook-Pro.local',
        'http://localhost:8642 and http://host.docker.internal:4000',
        'known secret: my-known-value',
        'a3f9c2e1b4d5a6f7e8d9c0b1a2f3e4d5c6b7',
      ].join('\n'),
      { ...identity, secrets: ['my-known-value'] }
    );
    expect(text).toBe(
      [
        'open [path] failed',
        'home [path]',
        'Authorization: Bearer [key]',
        'token=[key]',
        '[key]',
        'peer [host] and 127.0.0.1',
        '[host] said no',
        'host [host]',
        'http://localhost:8642 and http://host.docker.internal:4000',
        'known secret: [key]',
        '[key]',
      ].join('\n')
    );
    expect(removed).toHaveLength(10);
  });

  it('leaves ordinary words, file names and labels alone', () => {
    const plain = 'TypeError at ChatThread.tsx:212 in index.js, [host] and [key] stay';
    expect(redactReportText(plain, identity).text).toBe(plain);
  });
});
