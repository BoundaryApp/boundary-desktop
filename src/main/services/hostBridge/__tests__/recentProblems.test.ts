import { describe, expect, it } from 'vitest';
import { recentProblems } from '../recentProblems';

const scrub = (text: string) => text.split('/Users/fixture').join('«redacted»');
const record = (message: string, data: Record<string, unknown> = {}, area = 'startup') =>
  JSON.stringify({ ts: '2026-11-01T10:00:00.000Z', sessionId: 's', pid: 1, area, message, data });

describe('recentProblems', () => {
  it('keeps error records and skips routine ones', () => {
    const log = [
      record('main module boot'),
      record('renderer did-fail-load'),
      record('handler threw', { channel: 'x', errorName: 'TypeError' }),
      record('step done', { name: 'Error', code: 'ENOENT' }),
    ].join('\n');
    expect(recentProblems(log, scrub)).toEqual([
      { ts: '2026-11-01T10:00:00.000Z', area: 'startup', message: 'renderer did-fail-load' },
      { ts: '2026-11-01T10:00:00.000Z', area: 'startup', message: 'handler threw', errorName: 'TypeError' },
      { ts: '2026-11-01T10:00:00.000Z', area: 'startup', message: 'step done', errorName: 'Error', code: 'ENOENT' },
    ]);
  });

  it('drops secrets and chat text held in data', () => {
    const log = record('load failed', {
      stderr: 'token sk-fixture-secret',
      stdout: 'user said: my private question',
      message: 'my private question',
      stack: '/Users/fixture/app.js:1',
      argv: ['/Users/fixture/app'],
    });
    const out = JSON.stringify(recentProblems(log, scrub));
    expect(out).not.toContain('sk-fixture-secret');
    expect(out).not.toContain('private question');
    expect(out).not.toContain('/Users/fixture');
  });

  it('scrubs and cuts the message, and ignores text posing as an error name or code', () => {
    const [problem] = recentProblems(
      record(`podman failed at /Users/fixture/x ${'y'.repeat(400)}`, { name: 'my private question', code: 'some text' }),
      scrub
    );
    expect(problem.message.startsWith('podman failed at «redacted»/x')).toBe(true);
    expect(problem.message.length).toBeLessThanOrEqual(160);
    expect(problem).not.toHaveProperty('errorName');
    expect(problem).not.toHaveProperty('code');
  });

  it('skips a partial first line and malformed records', () => {
    const log = ['ge":"cut off"}', '{"ts":1}', 'null', record('load failed')].join('\n');
    expect(recentProblems(log, scrub)).toHaveLength(1);
  });

  it('returns the newest records up to the limit', () => {
    const log = ['a failed', 'b failed', 'c failed'].map((message) => record(message)).join('\n');
    expect(recentProblems(log, scrub, 2).map((problem) => problem.message)).toEqual(['b failed', 'c failed']);
  });
});
