import { describe, expect, it } from 'vitest';
import { basicAuthHeaderForTest } from '../hermesDashboardAuth';

// Export a tiny pure helper test via re-export pattern — test cookie/ticket URL shaping
// without network by exercising credential encoding.

describe('dashboard auth helpers', () => {
  it('encodes basic auth header', () => {
    const header = basicAuthHeaderForTest({ username: 'admin', password: 'secret' });
    expect(header).toBe(`Basic ${Buffer.from('admin:secret').toString('base64')}`);
  });
});
