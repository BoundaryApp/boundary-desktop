import { describe, expect, it } from 'vitest';
import { createFakeStackFiles } from '../../stackHost/fakeStackFiles';
import type { RunScriptOptions, StackCommands } from '../../stackHost/types';
import { isClientWritableEnvKey, projectEnvVia, projectEnvViaFiles, setProjectEnvValues } from '../projectEnv';
import { removeEnvLines, upsertEnvLines } from '../stackEnv';

// A stand-in for the stack's scripts/env.sh at v0.3.16: `set KEY VALUE` and `unset KEY` with
// --json print one `done` line with `changed`, an allowlist refusal is an `error` line with exit 2,
// and a busy lock is `busy` with exit 1. It changes the fake files the way upsert_env and
// remove_env change .env.
function fakeEnvScript(
  files: ReturnType<typeof createFakeStackFiles>,
  options: { fail?: { error: string; message: string; code: number } } = {}
) {
  const runs: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const runScript: StackCommands['runScript'] = async (script, args, run: RunScriptOptions) => {
    expect(script).toBe('scripts/env.sh');
    runs.push({ args, env: run.env });
    if (options.fail) {
      run.onStdout(JSON.stringify({ phase: 'error', error: options.fail.error, step: null, message: options.fail.message, logTail: [] }));
      return options.fail.code;
    }
    const [cmd, key, value] = args;
    const before = (await files.readText('stack', '.env')) ?? '';
    const after = cmd === 'set' ? upsertEnvLines(before, { [key]: value }) : removeEnvLines(before, [key]);
    if (after !== before) await files.writeText('stack', '.env', after);
    run.onStdout(JSON.stringify({ phase: 'done', key, changed: after !== before }));
    return 0;
  };
  return { runs, commands: { runScript, scriptEnv: async () => ({ COMPOSE_PROJECT_NAME: 'p' }) } };
}

const withScript = (env: string) =>
  createFakeStackFiles({ 'stack:.env': env, 'stack:scripts/env.sh': '#!/usr/bin/env bash\n' });

describe('isClientWritableEnvKey', () => {
  it('follows env.sh’s allowlist', () => {
    for (const key of ['LLM_MODEL', 'LLM_BINDING_API_KEY', 'N8N_IMAGE', 'HERMES_AGENT_IMAGE_TAG', 'HERMES_TERMINAL_BACKEND', 'CODING_EXTRA_ROOTS', 'CONTEXT_EXTRA_ROOTS', 'CALDAV_TZ']) {
      expect(isClientWritableEnvKey(key), key).toBe(true);
    }
    for (const key of ['LLM_PROXY_ADMIN_TOKEN', 'LIGHTRAG_LLM_MODEL', 'DETECTOR_PORT', 'COMPOSE_PROFILES', 'TWENTY_MCP_ENABLED', 'CODING_FOO_ENABLED', 'OPENAI_API_KEY']) {
      expect(isClientWritableEnvKey(key), key).toBe(false);
    }
  });
});

describe('projectEnvVia', () => {
  it('runs env.sh once per key that would change, naming Boundary as the lock holder', async () => {
    const files = withScript('LLM_MODEL=old\nHERMES_TERMINAL_BACKEND=ssh\nKEEP=1\n');
    const script = fakeEnvScript(files);
    const env = projectEnvVia(script.commands, files);

    expect(await env.set({ LLM_MODEL: 'new', HERMES_TERMINAL_BACKEND: 'ssh' })).toBe(true);
    expect(script.runs.map((r) => r.args)).toEqual([['set', 'LLM_MODEL', 'new', '--json']]);
    expect(script.runs[0].env).toMatchObject({ COMPOSE_PROJECT_NAME: 'p', STACK_CLIENT: 'boundary', STACK_LOCK_TIMEOUT: '30' });
    expect(await files.readText('stack', '.env')).toBe('LLM_MODEL=new\nHERMES_TERMINAL_BACKEND=ssh\nKEEP=1\n');

    expect(await env.set({ LLM_MODEL: 'new' })).toBe(false);
    expect(script.runs).toHaveLength(1);
  });

  it('compares the raw value, so a quoted value env.sh would rewrite still runs', async () => {
    const files = withScript("CODING_EXTRA_ROOTS='/a b'\n");
    const script = fakeEnvScript(files);
    await projectEnvVia(script.commands, files).set({ CODING_EXTRA_ROOTS: "'/a b'" });
    expect(script.runs).toHaveLength(0);
    await projectEnvVia(script.commands, files).set({ CODING_EXTRA_ROOTS: '/a b' });
    expect(script.runs).toHaveLength(1);
  });

  it('unsets only keys that are present', async () => {
    const files = withScript('OLD_IMAGE=x\nKEEP=1\n');
    const script = fakeEnvScript(files);
    expect(await projectEnvVia(script.commands, files).unset(['OLD_IMAGE', 'GONE_IMAGE'])).toBe(true);
    expect(script.runs.map((r) => r.args)).toEqual([['unset', 'OLD_IMAGE', '--json']]);
    expect(await files.readText('stack', '.env')).toBe('KEEP=1\n');
  });

  it('refuses keys env.sh doesn’t accept before running anything', async () => {
    const files = withScript('');
    const script = fakeEnvScript(files);
    await expect(projectEnvVia(script.commands, files).set({ DETECTOR_PORT: '1' })).rejects.toThrow(/DETECTOR_PORT/);
    expect(script.runs).toHaveLength(0);
  });

  it('rejects with env.sh’s error, such as a lock another client holds', async () => {
    const files = withScript('');
    const script = fakeEnvScript(files, { fail: { error: 'busy', message: 'another config change is running (pid 9, client cli)', code: 1 } });
    await expect(projectEnvVia(script.commands, files).set({ LLM_MODEL: 'm' })).rejects.toThrow(
      'env.sh set LLM_MODEL: busy: another config change is running (pid 9, client cli)'
    );
  });

  it('writes the file when the stack has no env.sh', async () => {
    const files = createFakeStackFiles({ 'stack:.env': 'LLM_MODEL=old\n' });
    const script = fakeEnvScript(files);
    expect(await projectEnvVia(script.commands, files).set({ LLM_MODEL: 'new' })).toBe(true);
    expect(script.runs).toHaveLength(0);
    expect(await files.readText('stack', '.env')).toBe('LLM_MODEL=new\n');
  });
});

describe('setProjectEnvValues', () => {
  it('sends allowed keys through env.sh and the rest to the file', async () => {
    const files = withScript('LIGHTRAG_LLM_MODEL=old\n');
    const script = fakeEnvScript(files);
    await setProjectEnvValues(projectEnvVia(script.commands, files), files, { LLM_MODEL: 'm', LIGHTRAG_LLM_MODEL: 'm' });
    expect(script.runs.map((r) => r.args[1])).toEqual(['LLM_MODEL']);
    expect(await files.readText('stack', '.env')).toBe('LIGHTRAG_LLM_MODEL=m\nLLM_MODEL=m\n');
  });
});

describe('projectEnvViaFiles', () => {
  it('reports no change for an unchanged file', async () => {
    const files = createFakeStackFiles({ 'stack:.env': 'A_IMAGE=1\n' });
    expect(await projectEnvViaFiles(files).set({ A_IMAGE: '1' })).toBe(false);
    expect(await projectEnvViaFiles(files).unset(['B_IMAGE'])).toBe(false);
  });
});
