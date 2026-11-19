import { describe, expect, it } from 'vitest';
import {
  connectTwentyWorkspace,
  disconnectTwentyWorkspace,
  type TwentyConnectInput,
} from '../crmScript';

const KEY_RW = 'rw-secret-key-123';
const KEY_RO = 'ro-secret-key-456';

const input = (over: Partial<TwentyConnectInput> = {}): TwentyConnectInput => ({
  slug: 'work',
  url: 'https://crm.example.com',
  keyRw: KEY_RW,
  keyRo: KEY_RO,
  access: 'write',
  replace: false,
  ...over,
});

type RunOptions = Parameters<typeof import('../crmScript').runCrmScript>[0];

function fakeRun(lines: string[], code = 0) {
  const calls: RunOptions[] = [];
  const run = async (options: RunOptions) => {
    calls.push(options);
    for (const line of lines) options.onLine?.(line);
    return { code, lines };
  };
  return { run, calls };
}

describe('connectTwentyWorkspace', () => {
  it('passes keys in the environment, never in argv', async () => {
    const { run, calls } = fakeRun(['[crm] Wrote x']);
    await connectTwentyWorkspace('/stack', { PATH: '/usr/bin' }, input(), run);
    expect(calls[0].args).toEqual(['add', '--slug', 'work', '--url', 'https://crm.example.com']);
    expect(calls[0].env).toMatchObject({
      PATH: '/usr/bin',
      TWENTY_KEY_RW: KEY_RW,
      TWENTY_KEY_RO: KEY_RO,
      TWENTY_ACCESS: 'write',
    });
    expect(calls[0].args.join(' ')).not.toContain(KEY_RW);

    await connectTwentyWorkspace('/stack', {}, input({ keyRo: '', access: 'read', replace: true }), run);
    expect(calls[1].args.at(-1)).toBe('--force');
    expect(calls[1].env.TWENTY_KEY_RO).toBe('');
    expect(calls[1].env.TWENTY_ACCESS).toBe('read');
  });

  it('maps the missing catalog tools to no-catalog', async () => {
    const { run } = fakeRun(
      [
        '[crm] TWENTY_KEY_RW: Twenty accepts it',
        '[crm] ERROR: https://x/mcp?mode=meta lists 4 tools but not get_tool_catalog learn_tools execute_tool; Hermes reaches records through those; nothing written',
      ],
      1
    );
    const r = await connectTwentyWorkspace('/stack', {}, input(), run);
    expect(r).toMatchObject({ ok: false, reason: 'no-catalog' });
  });

  it('maps "no answer from" to no-answer', async () => {
    const { run } = fakeRun(['[crm] ERROR: no answer from https://x/mcp — check the URL; nothing written'], 1);
    const r = await connectTwentyWorkspace('/stack', {}, input(), run);
    expect(r).toMatchObject({ ok: false, reason: 'no-answer' });
  });

  it('maps "rejects TWENTY_KEY_RO (HTTP 401)" to rejected with key RO and status 401', async () => {
    const { run } = fakeRun(
      [
        '[crm] TWENTY_KEY_RW: Twenty accepts it',
        '[crm] ERROR: Twenty rejects TWENTY_KEY_RO (HTTP 401); nothing written',
      ],
      1
    );
    const r = await connectTwentyWorkspace('/stack', {}, input(), run);
    expect(r).toMatchObject({ ok: false, reason: 'rejected', key: 'RO', status: 401 });
    expect(r.checks).toEqual(['[crm] TWENTY_KEY_RW: Twenty accepts it']);
  });

  it('maps "answered HTTP" to failed with the key and status', async () => {
    const { run } = fakeRun(['[crm] ERROR: https://x/mcp answered HTTP 502 for TWENTY_KEY_RW; nothing written'], 1);
    const r = await connectTwentyWorkspace('/stack', {}, input(), run);
    expect(r).toMatchObject({ ok: false, reason: 'failed', key: 'RW', status: 502 });
  });

  it('maps "exists (<path>); pass --force" to exists', async () => {
    // The wording of crm.sh add from stack v0.3.13, which names the store file.
    const { run } = fakeRun([
      "[crm] ERROR: workspace 'work' exists (/stack/data/addons/twenty/instances/work.json); pass --force (make crm-add FORCE=1) to replace it",
    ], 1);
    expect(await connectTwentyWorkspace('/stack', {}, input(), run)).toMatchObject({ ok: false, reason: 'exists' });
  });

  it.each([
    '--url must start with http:// or https://',
    '--slug must use lowercase letters, digits and hyphens',
    'TWENTY_ACCESS=read needs TWENTY_KEY_RO',
    'TWENTY_ACCESS must be read or write',
    'set TWENTY_KEY_RW (no terminal to ask in)',
    'a read/write key is required with TWENTY_ACCESS=write',
    'the URL holds a quote, backslash or control character',
    'a key holds whitespace, a quote, a backslash or a control character',
  ])('maps "%s" to invalid', async (message) => {
    const { run } = fakeRun([`[crm] ERROR: ${message}`], 1);
    expect(await connectTwentyWorkspace('/stack', {}, input(), run)).toMatchObject({ ok: false, reason: 'invalid', message });
  });

  it('maps exit 127 to failed', async () => {
    const { run } = fakeRun(['spawn bash ENOENT'], 127);
    expect(await connectTwentyWorkspace('/stack', {}, input(), run)).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('checks lists each "[crm] TWENTY_KEY_*: Twenty accepts it" line in order', async () => {
    const { run } = fakeRun([
      '[crm] TWENTY_KEY_RW: Twenty accepts it',
      '[crm] TWENTY_KEY_RO: Twenty accepts it',
      '[crm] Wrote compose/twenty/workspaces/work.env (crm-work)',
      '[crm] Set TWENTY_MCP_ENABLED=1',
    ]);
    const r = await connectTwentyWorkspace('/stack', {}, input(), run);
    expect(r).toEqual({
      ok: true,
      checks: ['[crm] TWENTY_KEY_RW: Twenty accepts it', '[crm] TWENTY_KEY_RO: Twenty accepts it'],
    });
  });

  it('no key text in the result', async () => {
    const { run } = fakeRun([`[crm] ERROR: --url must start with http:// or https://, got ${KEY_RW} and ${KEY_RO}`], 1);
    const r = await connectTwentyWorkspace('/stack', {}, input({ url: `${KEY_RW}${KEY_RO}` }), run);
    const text = JSON.stringify(r);
    expect(text).not.toContain(KEY_RW);
    expect(text).not.toContain(KEY_RO);
    expect(text).toContain('[key]');
  });
});

describe('disconnectTwentyWorkspace', () => {
  it('runs remove --slug', async () => {
    const { run, calls } = fakeRun(['[crm] Removed x']);
    await disconnectTwentyWorkspace('/stack', { PATH: '/p' }, 'work', run);
    expect(calls[0].args).toEqual(['remove', '--slug', 'work']);
    expect(calls[0].root).toBe('/stack');
  });

  it('throws the last [crm] ERROR line on failure', async () => {
    const { run } = fakeRun(["[crm] ERROR: no workspace 'work' in compose/twenty/workspaces"], 1);
    await expect(disconnectTwentyWorkspace('/stack', {}, 'work', run)).rejects.toThrow(
      "no workspace 'work' in compose/twenty/workspaces"
    );
  });
});
