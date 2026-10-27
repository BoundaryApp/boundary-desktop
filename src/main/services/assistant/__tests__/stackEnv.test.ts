import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv, readEnvFile, removeEnvLines, upsertEnvLines, writeEnvValues } from '../stackEnv';

describe('parseEnv', () => {
  it('reads KEY=value, strips quotes, and skips comments', () => {
    const parsed = parseEnv(`
# comment
ASSISTANT_DATA_ROOT="/Users/you/AssistantData"
OTHER='quoted'
EMPTY=
`);
    expect(parsed).toEqual({
      ASSISTANT_DATA_ROOT: '/Users/you/AssistantData',
      OTHER: 'quoted',
      EMPTY: '',
    });
  });

  it('reads export lines', () => {
    expect(parseEnv('export A=1\n  export   B = two\n')).toEqual({ A: '1', B: 'two' });
  });

  it('strips an unquoted value’s inline comment, as in the stack’s .env.example', () => {
    const parsed = parseEnv(
      [
        'LLM_BINDING_API_KEY=local-llm          # any non-empty string for most local servers',
        'NEO4J_USERNAME=neo4j\t# Neo4j requires the admin user to be neo4j',
        'BLANK= # nothing set',
        'QUOTED="a # b" # trailing',
        'HASH=abc#def',
      ].join('\n')
    );
    expect(parsed).toEqual({
      LLM_BINDING_API_KEY: 'local-llm',
      NEO4J_USERNAME: 'neo4j',
      BLANK: '',
      QUOTED: 'a # b',
      HASH: 'abc#def',
    });
  });

  it('keeps the last value of a repeated key and reads CRLF files', () => {
    expect(parseEnv('A=1\r\nA=2\r\n')).toEqual({ A: '2' });
  });
});

describe('upsertEnvLines', () => {
  it('replaces existing keys in place and appends new ones', () => {
    const before = '# comment\nAPI_SERVER_KEY=abc\nBOUNDARY_BRIDGE_TOKEN=old\n';
    expect(upsertEnvLines(before, { BOUNDARY_BRIDGE_TOKEN: 'new', BOUNDARY_BROWSER_TOKEN: 'b' })).toBe(
      '# comment\nAPI_SERVER_KEY=abc\nBOUNDARY_BRIDGE_TOKEN=new\nBOUNDARY_BROWSER_TOKEN=b\n'
    );
  });

  it('handles an empty file and a file without a trailing newline', () => {
    expect(upsertEnvLines('', { A: '1' })).toBe('A=1\n');
    expect(upsertEnvLines('X=2', { A: '1' })).toBe('X=2\nA=1\n');
    expect(upsertEnvLines('A=0', { A: '1' })).toBe('A=1');
  });

  it('appends after the last non-blank line', () => {
    expect(upsertEnvLines('A=1\n\n', { B: '2' })).toBe('A=1\nB=2\n');
    expect(upsertEnvLines('\n', { B: '2' })).toBe('B=2\n');
  });

  it('rewrites an export line and leaves commented-out keys alone', () => {
    expect(upsertEnvLines('# A=old\nexport A=0\n', { A: '1' })).toBe('# A=old\nA=1\n');
  });

  it('writes a value containing $ as given', () => {
    expect(upsertEnvLines('A=0\n', { A: 'p$&w$1' })).toBe('A=p$&w$1\n');
  });

  it('rewrites every line of a repeated key, so the last one read is the new value', () => {
    expect(upsertEnvLines('A=0\nB=1\nA=2\n', { A: '3' })).toBe('A=3\nB=1\nA=3\n');
  });

  it('returns the contents unchanged when given no values', () => {
    expect(upsertEnvLines('X=2', {})).toBe('X=2');
  });
});

describe('removeEnvLines', () => {
  it('drops only the named keys, export form included', () => {
    const env = 'A=1\nexport BOUNDARY_CALENDAR_X_PASSWORD=secret\n# note\nB=2\n';
    expect(removeEnvLines(env, ['BOUNDARY_CALENDAR_X_PASSWORD'])).toBe('A=1\n# note\nB=2\n');
  });

  it('keeps commented-out lines and the file’s last line ending', () => {
    expect(
      removeEnvLines('A=1\nOPENAI_API_KEY=x\n# OPENAI_API_KEY=y\nB=2', ['OPENAI_API_KEY'])
    ).toBe('A=1\n# OPENAI_API_KEY=y\nB=2');
  });

  it('leaves an empty file empty', () => {
    expect(removeEnvLines('', ['A'])).toBe('');
    expect(removeEnvLines('A=1\n', ['A'])).toBe('');
  });
});

describe('env files', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('creates the file and folder, then updates it', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-env-'));
    const envPath = path.join(dir, 'nested', '.env');
    expect(readEnvFile(envPath)).toEqual({});
    writeEnvValues(envPath, { A: '1' });
    writeEnvValues(envPath, { A: '2', B: 'x' });
    expect(fs.readFileSync(envPath, 'utf8')).toBe('A=2\nB=x\n');
    expect(readEnvFile(envPath)).toEqual({ A: '2', B: 'x' });
  });
});
