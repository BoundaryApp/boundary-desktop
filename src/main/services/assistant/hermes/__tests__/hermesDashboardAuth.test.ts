import { describe, expect, it } from 'vitest';
import { parseSetCookie } from '../hermesDashboardAuth';

describe('dashboard auth helpers', () => {
  it('keeps the attributes a browser session needs from a Set-Cookie', () => {
    expect(parseSetCookie('hermes_at=abc=; HttpOnly; Max-Age=43200; Path=/; SameSite=lax')).toEqual({
      name: 'hermes_at',
      value: 'abc=',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAgeS: 43200,
    });
    expect(parseSetCookie('rt=x; Secure; SameSite=None')).toMatchObject({
      secure: true,
      sameSite: 'no_restriction',
      maxAgeS: null,
    });
    expect(parseSetCookie('garbage')).toBeNull();
  });
});
