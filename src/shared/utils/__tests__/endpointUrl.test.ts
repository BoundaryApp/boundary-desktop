import { describe, expect, it } from 'vitest';
import { endpointPath, isOpenRouterUrl, sameEndpoint } from '../endpointUrl';

describe('endpointPath', () => {
  it('joins with one slash', () => {
    expect(endpointPath('http://127.0.0.1:1234/v1', 'models')).toBe('http://127.0.0.1:1234/v1/models');
    expect(endpointPath('http://127.0.0.1:1234/v1/', '/chat/completions')).toBe(
      'http://127.0.0.1:1234/v1/chat/completions'
    );
    expect(endpointPath('https://x.test/v1//', 'models')).toBe('https://x.test/v1/models');
  });
});

describe('sameEndpoint', () => {
  it('ignores trailing slashes, host case and a default port', () => {
    expect(sameEndpoint('http://localhost:1234/v1/', 'http://localhost:1234/v1')).toBe(true);
    expect(sameEndpoint('https://API.Example.com:443/v1', 'https://api.example.com/v1//')).toBe(true);
    expect(sameEndpoint(' http://localhost:1234/v1 ', 'http://localhost:1234/v1')).toBe(true);
  });

  it('tells different endpoints apart', () => {
    expect(sameEndpoint('http://localhost:1234/v1', 'http://localhost:1235/v1')).toBe(false);
    expect(sameEndpoint('https://x.test/V1', 'https://x.test/v1')).toBe(false);
  });

  it('matches nothing for a missing URL', () => {
    expect(sameEndpoint(undefined, undefined)).toBe(false);
    expect(sameEndpoint('', '')).toBe(false);
    expect(sameEndpoint('http://a.test', undefined)).toBe(false);
  });
});

describe('isOpenRouterUrl', () => {
  it('checks the host', () => {
    expect(isOpenRouterUrl('https://openrouter.ai/api/v1')).toBe(true);
    expect(isOpenRouterUrl('https://example.com/openrouter.ai')).toBe(false);
    expect(isOpenRouterUrl('https://example.com/v1')).toBe(false);
  });

  it('is false for an unparsable or missing URL', () => {
    expect(isOpenRouterUrl('openrouter.ai/api/v1')).toBe(false);
    expect(isOpenRouterUrl(undefined)).toBe(false);
  });
});
