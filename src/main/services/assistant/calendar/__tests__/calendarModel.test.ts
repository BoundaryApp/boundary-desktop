import { describe, expect, it } from 'vitest';
import {
  CALDAV_CHANGE_TOOLS,
  CALDAV_READ_TOOLS,
  calendarMcpEntry,
  calendarPasswordEnvKey,
  calendarPasswordProblem,
  calendarServerName,
  calendarSlug,
  normalizeCalendarUrl,
  removeEnvLines,
  toolsForAccess,
} from '../calendarModel';

describe('calendarSlug', () => {
  it('lowercases and joins runs of other characters with one hyphen', () => {
    expect(calendarSlug('Personal')).toBe('personal');
    expect(calendarSlug('  Work & Family!! ')).toBe('work-family');
    expect(calendarSlug('Kids’ soccer 2026')).toBe('kids-soccer-2026');
  });

  it('is empty when the name has no letters or numbers', () => {
    expect(calendarSlug('—!?')).toBe('');
  });

  it('never starts with the bootstrap-owned caldav- prefix in its server name', () => {
    expect(calendarServerName(calendarSlug('caldav personal'))).toBe('calendar-caldav-personal');
  });
});

describe('calendarPasswordEnvKey', () => {
  it('uppercases the slug and turns hyphens into underscores', () => {
    expect(calendarPasswordEnvKey('work-family')).toBe('BOUNDARY_CALENDAR_WORK_FAMILY_PASSWORD');
  });
});

describe('normalizeCalendarUrl', () => {
  it('fills in a known provider', () => {
    expect(normalizeCalendarUrl('icloud', '')).toBe('https://caldav.icloud.com/');
  });

  it('adds https to a bare host and the DAV path for Nextcloud', () => {
    expect(normalizeCalendarUrl('nextcloud', 'cloud.example.com')).toBe(
      'https://cloud.example.com/remote.php/dav/'
    );
    expect(normalizeCalendarUrl('other', 'dav.example.com:5232')).toBe('https://dav.example.com:5232/');
  });

  it('keeps a full URL and rejects other schemes', () => {
    expect(normalizeCalendarUrl('other', 'http://radicale.local:5232/sam/')).toBe(
      'http://radicale.local:5232/sam/'
    );
    expect(normalizeCalendarUrl('other', 'ftp://example.com')).toBe('');
    expect(normalizeCalendarUrl('other', '')).toBe('');
  });
});

describe('calendarMcpEntry', () => {
  it('names the password env key instead of carrying the password', () => {
    const entry = calendarMcpEntry({
      slug: 'personal',
      url: 'https://caldav.icloud.com/',
      username: 'sam@example.com',
      access: 'read',
    });
    expect(entry).toMatchObject({
      url: 'http://caldav-mcp:8080/mcp',
      trust: 'untrusted',
      headers: {
        'X-Caldav-Url': 'https://caldav.icloud.com/',
        'X-Caldav-Username': 'sam@example.com',
        'X-Caldav-Password': '${BOUNDARY_CALENDAR_PERSONAL_PASSWORD}',
      },
      tools: { include: [...CALDAV_READ_TOOLS] },
    });
  });

  it('includes the change tools only for change access', () => {
    expect(toolsForAccess('read')).toEqual([...CALDAV_READ_TOOLS]);
    expect(toolsForAccess('change')).toEqual([...CALDAV_READ_TOOLS, ...CALDAV_CHANGE_TOOLS]);
    expect(toolsForAccess('off')).toEqual([]);
  });
});

describe('calendarPasswordProblem', () => {
  it('accepts app passwords and other symbols both Hermes readers keep', () => {
    expect(calendarPasswordProblem('abcd-efgh-ijkl-mnop')).toBeNull();
    expect(calendarPasswordProblem('Ab1-_.@%+=:,/!&*()[]{}<>?~^|;`')).toBeNull();
  });

  it('refuses characters Hermes would change', () => {
    for (const pw of ['has space', "it's", 'a"b', 'back\\slash', 'hash#tag', 'dollar$sign']) {
      expect(calendarPasswordProblem(pw)).toMatch(/app password/);
    }
    expect(calendarPasswordProblem('')).toBe('Enter the password.');
  });
});

describe('removeEnvLines', () => {
  it('drops only the named keys, export form included', () => {
    const env = 'A=1\nexport BOUNDARY_CALENDAR_X_PASSWORD=secret\n# note\nB=2\n';
    expect(removeEnvLines(env, ['BOUNDARY_CALENDAR_X_PASSWORD'])).toBe('A=1\n# note\nB=2\n');
  });

  it('leaves an empty file empty', () => {
    expect(removeEnvLines('', ['A'])).toBe('');
    expect(removeEnvLines('A=1\n', ['A'])).toBe('');
  });
});
