import { describe, expect, it } from 'vitest';
import {
  buildHermesConfigSetExec,
  HERMES_CONFIG_SECRET_ENV,
  redactSecrets,
} from '../hermesConfigSetExec';

describe('buildHermesConfigSetExec', () => {
  it('passes non-secret values as plain args', () => {
    expect(buildHermesConfigSetExec('browser', 'model.default', 'llama')).toEqual({
      args: ['exec', '-T', 'hermes', 'hermes', '-p', 'browser', 'config', 'set', 'model.default', 'llama'],
    });
  });

  it('keeps a secret value out of argv and forwards it by env name', () => {
    const { args, env } = buildHermesConfigSetExec('', 'model.api_key', 'sk-live-123', {
      secret: true,
    });
    expect(args.join(' ')).not.toContain('sk-live-123');
    expect(args).toContain(HERMES_CONFIG_SECRET_ENV);
    expect(args.slice(-4)).toEqual(['hermes', 'config', 'set', 'model.api_key']);
    expect(env).toEqual({ [HERMES_CONFIG_SECRET_ENV]: 'sk-live-123' });
  });
});

describe('redactSecrets', () => {
  it('replaces every occurrence and ignores empty secrets', () => {
    expect(redactSecrets('Command failed: set k sk-1 (sk-1)', ['sk-1', undefined, ''])).toBe(
      'Command failed: set k «redacted» («redacted»)'
    );
  });
});
