import { describe, expect, it } from 'vitest';
import type { RunScriptOptions, StackCommands } from '../../../stackHost/types';
import { SCRIPT_CANCELLED } from '../../../stackHost/localScript';
import { parseExportProfileLine, runSessionsExport } from '../sessionsExport';

// The fake prints the lines `scripts/sessions.sh export --json` prints at stack v0.3.16 (its
// header and `cmd_export`, `jl_fail` in scripts/lib/json-lines.sh), with the same exit codes.

type Fake = { stdout: string[]; stderr?: string[]; code: number };

function commands(fake: Fake, seen: { script?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const runScript: StackCommands['runScript'] = async (script, args, options: RunScriptOptions) => {
    Object.assign(seen, { script, args, env: options.env });
    for (const line of fake.stdout) options.onStdout(line);
    for (const line of fake.stderr ?? []) options.onStderr(line);
    return fake.code;
  };
  return { runScript, scriptEnv: async () => ({ PATH: '/bin', COMPOSE_PROJECT_NAME: 'p' }) };
}

describe('runSessionsExport', () => {
  it('runs export with --dest and --json and reads the profile and done lines', async () => {
    const seen: { script?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {};
    const profiles: string[] = [];
    const outcome = await runSessionsExport({
      commands: commands(
        {
          stdout: [
            '{"phase":"profile","profile":"default","sessions":4,"messages":11}',
            '{"phase":"profile","profile":"coder","sessions":2,"messages":7}',
            '{"phase":"done","action":"export","dest":"/x/Boundary history 2026-11-20","sessions":6,"messages":18}',
          ],
          code: 0,
        },
        seen
      ),
      dest: '/x/Boundary history 2026-11-20',
      env: { SESSIONS_PY: 'py' },
      onProfile: (line) => profiles.push(line.profile),
    });
    expect(seen.script).toBe('scripts/sessions.sh');
    expect(seen.args).toEqual(['export', '--dest', '/x/Boundary history 2026-11-20', '--json']);
    expect(seen.env).toMatchObject({ COMPOSE_PROJECT_NAME: 'p', SESSIONS_PY: 'py' });
    expect(profiles).toEqual(['default', 'coder']);
    expect(outcome).toEqual({
      kind: 'done',
      dest: '/x/Boundary history 2026-11-20',
      sessions: 6,
      messages: 18,
      profiles: [
        { profile: 'default', sessions: 4, messages: 11 },
        { profile: 'coder', sessions: 2, messages: 7 },
      ],
    });
  });

  it('names bad_input, hermes_not_running and command_failed from the error line', async () => {
    const cases = [
      ['bad_input', 2, '/x is not an empty directory'],
      ['hermes_not_running', 1, 'could not run python in the hermes service; start the stack with make up'],
      ['command_failed', 4, 'export of profile coder failed'],
    ] as const;
    for (const [error, code, message] of cases) {
      const outcome = await runSessionsExport({
        commands: commands({
          stdout: [`{"phase":"error","error":"${error}","step":null,"message":"${message}","logTail":[]}`],
          stderr: [`error: ${message}`],
          code,
        }),
        dest: '/x',
      });
      expect(outcome).toEqual({ kind: 'failed', error, message });
    }
  });

  it('reports a cancelled run', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runSessionsExport({
      commands: commands({ stdout: ['{"phase":"profile","profile":"default","sessions":1,"messages":1}'], code: SCRIPT_CANCELLED }),
      dest: '/x',
      signal: controller.signal,
    });
    expect(outcome).toEqual({ kind: 'cancelled' });
  });

  it('fails a run that ends without a done or error line', async () => {
    const outcome = await runSessionsExport({
      commands: commands({ stdout: [], stderr: ['sessions.sh: line 1: boom'], code: 3 }),
      dest: '/x',
    });
    expect(outcome).toMatchObject({ kind: 'failed', error: 'command_failed' });
  });

  it('fails a done line that isn’t an export', async () => {
    const outcome = await runSessionsExport({
      commands: commands({ stdout: ['{"phase":"done","action":"import","imported":0}'], code: 0 }),
      dest: '/x',
    });
    expect(outcome).toMatchObject({ kind: 'failed', error: 'command_failed' });
  });
});

describe('parseExportProfileLine', () => {
  it('reads counts and ignores other lines', () => {
    expect(parseExportProfileLine({ phase: 'profile', profile: 'w', sessions: 3, messages: 9 })).toEqual({
      profile: 'w',
      sessions: 3,
      messages: 9,
    });
    expect(parseExportProfileLine({ phase: 'profile', profile: 'w', sessions: -1 })).toEqual({ profile: 'w', sessions: 0, messages: 0 });
    expect(parseExportProfileLine({ phase: 'setup', profile: 'w' })).toBeNull();
    expect(parseExportProfileLine({ phase: 'profile' })).toBeNull();
  });
});
