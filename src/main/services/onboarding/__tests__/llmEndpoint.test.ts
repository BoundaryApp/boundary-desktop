import { describe, expect, it } from 'vitest';
import { llmAuthorizationHeader } from '../llmEndpoint';

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
