import { describe, expect, it } from 'vitest';
import { basicAuthHeaderForTest, parseSetCookie } from '../hermesDashboardAuth';

// Export a tiny pure helper test via re-export pattern — test cookie/ticket URL shaping
// without network by exercising credential encoding.

describe('dashboard auth helpers', () => {
  it('encodes basic auth header', () => {
    const header = basicAuthHeaderForTest({ username: 'admin', password: 'secret' });
    expect(header).toBe(`Basic ${Buffer.from('admin:secret').toString('base64')}`);
  });

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
