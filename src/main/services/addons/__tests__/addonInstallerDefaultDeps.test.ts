import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunScriptOptions } from '../../stackHost/types';

const stack = vi.hoisted(() => ({
  runs: [] as Array<{ script: string; args: string[]; options: RunScriptOptions }>,
  stdout: [] as string[],
}));

vi.mock('../../assistant/AssistantStackService', () => ({
  getAssistantStackAccess: () => ({
    root: '/stacks/test',
    scriptEnv: async (profiles: string[]) => ({ COMPOSE_PROJECT_NAME: 'boundary', PROFILES: profiles.join(',') }),
    runScript: async (script: string, args: string[], options: RunScriptOptions) => {
      stack.runs.push({ script, args, options });
      for (const line of stack.stdout) options.onStdout(line);
      return 0;
    },
  }),
  reloadHermesForAddons: vi.fn(),
}));

import { createDefaultAddonInstallerDeps } from '../addonInstaller';

describe('the installer’s default addonScript', () => {
  beforeEach(() => {
    stack.runs = [];
    stack.stdout = [];
  });

  it('runs scripts/addon.sh with the stack’s script environment plus the given env, and the input on stdin', async () => {
    stack.stdout = ['{"phase":"setup","step":"flags","status":"running"}', '{"phase":"done","addon":"twenty"}'];
    const lines: unknown[] = [];
    const controller = new AbortController();
    const outcome = await createDefaultAddonInstallerDeps().addonScript(['enable', 'twenty', '--json'], {
      env: { TWENTY_OWNER_FIRST_NAME: 'Ada' },
      onLine: (l) => lines.push(l),
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    expect(outcome.kind).toBe('done');
    expect(lines).toEqual([{ phase: 'setup', step: 'flags', status: 'running' }]);
    expect(stack.runs).toHaveLength(1);
    const run = stack.runs[0]!;
    expect(run.script).toBe('scripts/addon.sh');
    expect(run.args).toEqual(['enable', 'twenty', '--json']);
    expect(run.options.env).toEqual({ COMPOSE_PROJECT_NAME: 'boundary', PROFILES: '', TWENTY_OWNER_FIRST_NAME: 'Ada' });
    expect(run.options.timeoutMs).toBe(1_000);
    expect(run.options.signal).toBe(controller.signal);
  });

  it('writes configure’s values to stdin as one JSON object', async () => {
    const outcome = await createDefaultAddonInstallerDeps().addonScript(['configure', 'twenty'], { input: { local: false } });
    expect(outcome).toMatchObject({ kind: 'exited', code: 0 });
    expect(stack.runs[0]?.options.input).toBe('{"local":false}');
  });
});
