import { describe, expect, it } from 'vitest';
import { hermesStaleTimeoutFor, upstreamIsLocal } from '../hermesStreamTimeout';

describe('hermesStreamTimeout', () => {
  it.each([
    'http://host.docker.internal:1234/v1',
    'http://localhost:11434/v1',
    'http://ollama:11434/v1',
    'http://127.0.0.1:1234/v1',
    'http://192.168.1.20:1234/v1',
    'http://10.0.0.5/v1',
    'http://172.20.0.3/v1',
    'http://100.100.1.2/v1',
    'http://studio.local:1234/v1',
    'http://[::1]:1234/v1',
    'http://[fd00::5]/v1',
  ])('treats %s as local', (url) => {
    expect(upstreamIsLocal(url)).toBe(true);
  });

  it.each([
    'https://openrouter.ai/api/v1',
    'https://api.openai.com/v1',
    'http://8.8.8.8/v1',
    'http://172.32.0.1/v1',
    'https://x.baseten.co/v1',
  ])('treats %s as cloud', (url) => {
    expect(upstreamIsLocal(url)).toBe(false);
  });

  it('sizes the timeout for the upstream, and lets the .env override win', () => {
    expect(hermesStaleTimeoutFor('http://host.docker.internal:1234/v1')).toBe(300);
    expect(hermesStaleTimeoutFor('https://openrouter.ai/api/v1')).toBe(180);
    expect(hermesStaleTimeoutFor('https://openrouter.ai/api/v1', '600')).toBe(600);
    expect(hermesStaleTimeoutFor('https://openrouter.ai/api/v1', '')).toBe(180);
    expect(hermesStaleTimeoutFor('https://openrouter.ai/api/v1', 'soon')).toBe(180);
  });
});
