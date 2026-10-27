import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasPython3, NO_PYTHON3, runPython } from '../../__tests__/fixtures/runPython';
import { caldavProbeInput, parseCaldavProbeOutput } from '../caldavProbe';

/**
 * Runs the sign-in probe Boundary pipes into the caldav-mcp container, with stand-ins for
 * `requests` and `caldav` (fixtures/caldav-python) that serve a made-up CalDAV server.
 */

const STANDINS = path.join(import.meta.dirname, 'fixtures', 'caldav-python');
const PASSWORD = 'made-up-pass';

const SERVER = {
  username: 'sam',
  password: PASSWORD,
  routes: {
    'https://dav.example.com/.well-known/caldav': {
      final: 'https://dav.example.com/dav/',
      principal: '/dav/principals/sam/',
    },
  },
  calendars: {
    'https://dav.example.com/dav/principals/sam/': [
      { name: 'Home', url: 'https://dav.example.com/dav/calendars/sam/home/' },
      { name: 'Work', url: 'https://dav.example.com/dav/calendars/sam/work/' },
    ],
  },
};

function probe(password: string, env: Record<string, string> = {}, server: object = SERVER) {
  const run = runPython(caldavProbeInput({ url: 'https://dav.example.com/', username: 'sam', password }), STANDINS, {
    STANDIN_CALDAV: JSON.stringify(server),
    ...env,
  });
  return { ...run, result: parseCaldavProbeOutput(run.stdout, password) };
}

describe.skipIf(!hasPython3)(`CalDAV probe on python3 (${hasPython3 ? 'run' : NO_PYTHON3})`, () => {
  it('finds the principal through .well-known and lists its calendars', () => {
    const run = probe(PASSWORD);
    expect(run.status).toBe(0);
    expect(run.result).toEqual({
      status: 'ok',
      url: 'https://dav.example.com/dav/',
      calendars: SERVER.calendars['https://dav.example.com/dav/principals/sam/'],
    });
  });

  it('reports a wrong password as rejected', () => {
    const run = probe('wrong-pass');
    expect(run.status).toBe(0);
    expect(run.result).toEqual({ status: 'rejected' });
  });

  it('reports an unreachable server with the password scrubbed from the error', () => {
    const server = {
      ...SERVER,
      routes: {},
      errors: { 'https://dav.example.com/.well-known/caldav': `refused for ${PASSWORD}` },
    };
    const run = probe(PASSWORD, {}, server);
    expect(run.status).toBe(0);
    // .well-known raised; the base URL then answered 404, which is what's reported.
    expect(run.result).toEqual({ status: 'unreachable', error: 'HTTP 404' });

    const onlyError = { ...server, errors: { ...server.errors, 'https://dav.example.com/': `refused for ${PASSWORD}` } };
    const failed = probe(PASSWORD, {}, onlyError);
    expect(failed.result).toEqual({ status: 'unreachable', error: 'ConnectionError: refused for [REDACTED]' });
    expect(failed.stdout).not.toContain(PASSWORD);
  });

  it('is an error, not a sign-in result, when the caldav library is missing', () => {
    const run = probe(PASSWORD, { STANDIN_CALDAV_MISSING: '1' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('ModuleNotFoundError');
    expect(run.result.status).toBe('error');
  });
});
