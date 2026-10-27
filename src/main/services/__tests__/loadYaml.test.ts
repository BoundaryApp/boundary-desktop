import { describe, expect, it } from 'vitest';
import { loadYaml } from '../loadYaml';

describe('loadYaml', () => {
  it('gives undefined for input with no document', () => {
    expect(loadYaml('')).toBeUndefined();
    expect(loadYaml('  \n')).toBeUndefined();
    expect(loadYaml('# only a comment\n')).toBeUndefined();
  });

  it('merges << keys', () => {
    expect(loadYaml('base: &b {image: x}\nweb:\n  <<: *b\n  port: 80\n')).toEqual({
      base: { image: 'x' },
      web: { image: 'x', port: 80 },
    });
  });

  it('keeps dates as strings', () => {
    expect(loadYaml('at: 2026-01-01')).toEqual({ at: '2026-01-01' });
  });

  it('throws for more than one document or invalid YAML', () => {
    expect(() => loadYaml('a: 1\n---\nb: 2\n')).toThrow(/single document/);
    expect(() => loadYaml('a: [1')).toThrow();
  });
});
