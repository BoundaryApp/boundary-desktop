import { describe, expect, it } from 'vitest';
import {
  labelForOrigin,
  originFromInput,
  signInOriginMismatch,
  suggestSignInSites,
} from '../../../shared/vaultSites';

describe('vaultSites', () => {
  it('reads an origin from a URL or a bare host, not from a name', () => {
    expect(originFromInput('https://www.linkedin.com/in/someone')).toBe('https://www.linkedin.com');
    expect(originFromInput('github.com/login')).toBe('https://github.com');
    expect(originFromInput('LinkedIn')).toBeNull();
    expect(originFromInput('ftp://example.com')).toBeNull();
    expect(originFromInput('')).toBeNull();
  });

  it('suggests known sites by name or domain', () => {
    expect(suggestSignInSites('link').map((s) => s.name)).toEqual(['LinkedIn']);
    expect(suggestSignInSites('git').map((s) => s.origin)).toEqual(['https://github.com']);
    expect(suggestSignInSites('linkedin.com')).toEqual([]);
  });

  it('spots a login saved for the wrong part of a known site', () => {
    expect(signInOriginMismatch('https://linkedin.com')?.origin).toBe('https://www.linkedin.com');
    expect(signInOriginMismatch('https://mail.google.com')?.origin).toBe('https://accounts.google.com');
    expect(signInOriginMismatch('https://www.linkedin.com')).toBeNull();
    expect(signInOriginMismatch('https://example.com')).toBeNull();
  });

  it('labels a login by site name, else by host', () => {
    expect(labelForOrigin('https://www.linkedin.com')).toBe('LinkedIn');
    expect(labelForOrigin('https://www.example.com')).toBe('example.com');
  });
});
