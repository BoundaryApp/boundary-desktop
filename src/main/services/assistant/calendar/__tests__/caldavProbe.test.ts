import { describe, expect, it } from 'vitest';
import { caldavProbeArgs, caldavProbeInput, parseCaldavProbeOutput } from '../caldavProbe';

describe('caldavProbeInput', () => {
  it('puts the credentials in the program as one Python string literal', () => {
    const input = caldavProbeInput({ url: 'https://dav.example.com/', username: 'sam', password: 'p"w\\x' });
    const first = input.split('\n')[0];
    expect(first.startsWith('CREDS_JSON = "')).toBe(true);
    // A JSON string literal: decoding it twice gives the credentials back.
    expect(JSON.parse(JSON.parse(first.slice('CREDS_JSON = '.length)))).toEqual({
      url: 'https://dav.example.com/',
      username: 'sam',
      password: 'p"w\\x',
    });
  });

  it('runs the program from stdin in the caldav-mcp container, never with credentials in argv', () => {
    expect(caldavProbeArgs()).toEqual(['exec', '-T', 'caldav-mcp', 'python', '-']);
  });
});

describe('parseCaldavProbeOutput', () => {
  it('reads the calendars from a good sign-in', () => {
    const out =
      'noise\nCALDAV_PROBE {"status": "ok", "url": "https://dav.example.com/", "calendars": [{"name": "Home", "url": "https://dav.example.com/sam/home/"}, {"name": "", "url": ""}]}\n';
    expect(parseCaldavProbeOutput(out, 'pw')).toEqual({
      status: 'ok',
      url: 'https://dav.example.com/',
      calendars: [{ name: 'Home', url: 'https://dav.example.com/sam/home/' }],
    });
  });

  it('reports a rejected sign-in', () => {
    expect(parseCaldavProbeOutput('CALDAV_PROBE {"status": "rejected"}', 'pw')).toEqual({ status: 'rejected' });
  });

  it('scrubs the password from an unreachable server’s error', () => {
    const out = 'CALDAV_PROBE {"status": "unreachable", "error": "failed with s3cret in it"}';
    expect(parseCaldavProbeOutput(out, 's3cret')).toEqual({
      status: 'unreachable',
      error: 'failed with [REDACTED] in it',
    });
  });

  it('is an error when the probe printed nothing usable', () => {
    expect(parseCaldavProbeOutput('Traceback …', 'pw').status).toBe('error');
    expect(parseCaldavProbeOutput('CALDAV_PROBE {not json', 'pw').status).toBe('error');
  });
});
