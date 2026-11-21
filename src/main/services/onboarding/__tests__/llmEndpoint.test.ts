import { describe, expect, it } from 'vitest';
import { llmAuthorizationHeader, llmRequestHeaders } from '../llmEndpoint';

describe('llmAuthorizationHeader', () => {
  it('uses Api-Key for the api-key scheme or Baseten, Bearer otherwise', () => {
    expect(llmAuthorizationHeader({ apiKey: 'k', authScheme: 'api-key' })).toBe('Api-Key k');
    expect(llmAuthorizationHeader({ apiKey: 'k', provider: 'baseten' })).toBe('Api-Key k');
    expect(llmAuthorizationHeader({ apiKey: 'k', provider: 'baseten', authScheme: 'bearer' })).toBe(
      'Api-Key k'
    );
    expect(llmAuthorizationHeader({ apiKey: 'k', provider: 'openrouter' })).toBe('Bearer k');
    expect(llmAuthorizationHeader({ apiKey: 'k' })).toBe('Bearer k');
  });

  it('sends no header without a key', () => {
    expect(llmAuthorizationHeader({ apiKey: '', authScheme: 'api-key' })).toBeUndefined();
    expect(llmAuthorizationHeader({ apiKey: undefined })).toBeUndefined();
  });
});

describe('llmRequestHeaders', () => {
  it('sends Bearer auth and Content-Type for a plain connection', () => {
    expect(llmRequestHeaders({ apiKey: 'k' })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer k',
    });
  });

  it('uses the connection’s scheme and adds its extra headers', () => {
    expect(
      llmRequestHeaders({ apiKey: 'k', authScheme: 'api-key', extraHeaders: { 'X-Team': 'blue' } })
    ).toEqual({ 'Content-Type': 'application/json', Authorization: 'Api-Key k', 'X-Team': 'blue' });
  });

  it('sends no Authorization without a key and no Content-Type when asked', () => {
    expect(llmRequestHeaders({}, { contentType: false })).toEqual({});
  });
});
