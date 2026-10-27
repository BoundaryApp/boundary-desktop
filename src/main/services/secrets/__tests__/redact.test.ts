import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../redact';

describe('redactSecrets', () => {
  it('replaces every occurrence and ignores empty secrets', () => {
    expect(redactSecrets('Command failed: set k sk-1 (sk-1)', ['sk-1', undefined, null, ''])).toBe(
      'Command failed: set k «redacted» («redacted»)'
    );
  });

  it('takes any iterable of secrets', () => {
    expect(redactSecrets('a pw b tok', new Set(['pw', 'tok']))).toBe('a «redacted» b «redacted»');
  });
});
