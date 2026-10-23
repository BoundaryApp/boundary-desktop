import { describe, expect, it } from 'vitest';
import { hermesSessionSourceLabel } from '../../../../../shared/types/hermesChat';

describe('hermesSessionSourceLabel', () => {
  it('maps known sources', () => {
    expect(hermesSessionSourceLabel('webui')).toBe('WebUI');
    expect(hermesSessionSourceLabel('boundary')).toBe('App');
    expect(hermesSessionSourceLabel('tui')).toBe('App');
    expect(hermesSessionSourceLabel('cli')).toBe('App');
    expect(hermesSessionSourceLabel('telegram')).toBe('Telegram');
  });

  it('returns null for empty sources', () => {
    expect(hermesSessionSourceLabel(undefined)).toBeNull();
    expect(hermesSessionSourceLabel('')).toBeNull();
    expect(hermesSessionSourceLabel('   ')).toBeNull();
  });
});
