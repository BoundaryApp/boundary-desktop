import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADDON_SCRIPT_TIMED_OUT, outcomeText, redact, runAddonScript, runAddonScriptPlain, runScriptJson } from '../addonScript';

// A stand-in `scripts/budget.sh` and `scripts/addon.sh` in a temp folder, printing the lines the
// stack's scripts print (CR 0026 round 4; budget.sh `emit_error`, addon.sh `ev_done`/`ev_error`).
// FAKE picks the scenario. Each run records its argv and stdin, so a test can check that a
// credential travels on stdin only.

const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$FAKE_DIR/argv"
stdin="$(cat)"
printf '%s' "$stdin" > "$FAKE_DIR/stdin"
case "$FAKE" in
  budgets)
    printf '{"phase":"budget","sync_id":"s-1","name":"Home","encrypted":false}\\n'
    printf '{"phase":"budget","sync_id":"s-2","name":"Work","encrypted":true}\\n'
    printf '{"phase":"done"}\\n' ;;
  error)
    printf '{"phase":"error","error":"%s","message":"the server refused the password"}\\n' "$FAKE_ERROR"
    printf 'error: the server refused the password\\n' >&2
    exit 4 ;;
  addon-error)
    printf '{"phase":"setup","step":"check","status":"running"}\\n'
    printf '{"phase":"setup","step":"check","status":"error"}\\n'
    printf '{"phase":"error","error":"no_access","step":"check","message":"this account cannot open that budget","logTail":["[budget] checking"]}\\n'
    exit 4 ;;
  no-done)
    printf '{"phase":"setup","step":"check","status":"running"}\\n'
    printf 'Traceback: something broke\\n' >&2
    exit 3 ;;
  missing-input)
    if [ -z "$stdin" ]; then
      printf '{"phase":"error","error":"not_found","message":"stdin is not a JSON object"}\\n'
      exit 2
    fi
    printf '{"phase":"done"}\\n' ;;
  echo-secret)
    printf 'leaked %s\\n' "$stdin" >&2
    printf '{"phase":"error","error":"server_unreachable","message":"sign-in failed: %s"}\\n' "$(printf '%s' "$stdin" | sed 's/.*"password":"\\([^"]*\\)".*/\\1/')"
    exit 4 ;;
  after-done)
    printf '{"phase":"done","account":"home","mcp":["budget-home"]}\\n'
    printf '{"phase":"error","error":"late","message":"ignored"}\\n' ;;
  rate-limited)
    printf '{"phase":"error","error":"rate_limited","step":"check","message":"Bitwarden is rate limiting","logTail":[],"retryAfter":42}\n'
    exit 4 ;;
  status)
    printf '{"slug": "home", "mode": "cloud", "scope": "folder:Agent", "unlock": "manual", "state": "locked", "error": null, "retry_after": null}\n'
    printf 'not json\n'
    printf '{"file": "x.env", "slug": null, "state": "refused", "error": "bad_file"}\n' ;;
  broker-down)
    printf '[vault] ERROR: the Bitwarden broker is not running\n' >&2
    exit 1 ;;
  mailboxes)
    printf '[\n  {\n    "name": "INBOX",\n    "messages": 3\n  }\n]\n' ;;
  plain-leak)
    printf 'host check for %s\n' "$stdin"
    printf 'failed: %s\n' "$stdin" >&2
    exit 2 ;;
  slow)
    sleep 5 ;;
esac
`;

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-script-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['budget.sh', 'addon.sh', 'vault.sh']) fs.writeFileSync(path.join(root, 'scripts', name), FAKE, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const run = (fake: string, extra: Partial<Parameters<typeof runAddonScript>[0]> = {}, env: Record<string, string> = {}) =>
  runAddonScript({
    root,
    script: 'budget.sh',
    args: ['budgets', '--json'],
    env: { PATH: process.env.PATH, FAKE: fake, FAKE_DIR: root, ...env },
    ...extra,
  });

describe('runAddonScript', () => {
  it('collects the non-final lines and resolves with the done line', async () => {
    const seen: string[] = [];
    const outcome = await run('budgets', { input: { server: 'local' }, onLine: (l) => seen.push(String(l.sync_id)) });
    expect(outcome.kind).toBe('done');
    expect(outcome.lines.map((l) => l.name)).toEqual(['Home', 'Work']);
    expect(seen).toEqual(['s-1', 's-2']);
  });

  it.each(['bad_slug', 'exists', 'login_refused', 'token_expired', 'no_access', 'encryption_password', 'server_unreachable', 'timeout', 'bad_access'])(
    'keys a failure on the error name %s, not the exit code',
    async (error) => {
      const outcome = await run('error', { input: { server: 'local' } }, { FAKE_ERROR: error });
      expect(outcome).toMatchObject({ kind: 'error', error, message: 'the server refused the password', step: null });
      // budget.sh's error line has no logTail; the stderr lines stand in.
      expect(outcome.kind === 'error' && outcome.logTail).toEqual(['error: the server refused the password']);
    }
  );

  it('takes addon.sh’s step and logTail from its error line', async () => {
    const outcome = await run('addon-error', { script: 'addon.sh', args: ['connect', 'actual', '--instance', 'home', '--json'] });
    expect(outcome).toMatchObject({ kind: 'error', error: 'no_access', step: 'check', logTail: ['[budget] checking'] });
    expect(outcome.lines).toHaveLength(2);
  });

  it('reports an exit with no done or error line, with its stderr', async () => {
    const outcome = await run('no-done');
    expect(outcome).toMatchObject({ kind: 'exited', code: 3, logTail: ['Traceback: something broke'] });
    expect(outcomeText(outcome)).toBe('the script exited with code 3 and no result: Traceback: something broke');
  });

  it('closes stdin when there is no input, which the script reports as its own error', async () => {
    expect(await run('missing-input')).toMatchObject({ kind: 'error', error: 'not_found', message: 'stdin is not a JSON object' });
    expect(fs.readFileSync(path.join(root, 'stdin'), 'utf8')).toBe('');
  });

  it('sends the credential on stdin only, never in argv', async () => {
    await run('missing-input', {
      args: ['connect', '--slug', 'home', '--json'],
      input: { server: 'https://budget.example.com', password: 'hunter2-secret' },
    });
    expect(fs.readFileSync(path.join(root, 'argv'), 'utf8')).toBe('connect --slug home --json\n');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'stdin'), 'utf8'))).toEqual({
      server: 'https://budget.example.com',
      password: 'hunter2-secret',
    });
  });

  it('redacts a credential a script echoes, in the message and the log tail', async () => {
    const outcome = await run('echo-secret', { input: { server: 'https://budget.example.com', password: 'hunter2-secret' } });
    expect(JSON.stringify(outcome)).not.toContain('hunter2-secret');
    expect(outcome).toMatchObject({ kind: 'error', message: 'sign-in failed: [redacted]' });
  });

  it('ignores anything after the final line', async () => {
    const outcome = await run('after-done');
    expect(outcome).toMatchObject({ kind: 'done', done: { mcp: ['budget-home'] } });
  });

  it('stops a script that runs past its time limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = run('slow', { timeoutMs: 60_000 });
      vi.advanceTimersByTime(60_000);
      const outcome = await pending;
      expect(outcome).toMatchObject({ kind: 'exited', code: ADDON_SCRIPT_TIMED_OUT });
      expect(outcomeText(outcome)).toBe('the script ran past its time limit');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runAddonScript with vault.sh', () => {
  it('keeps rate_limited’s retryAfter from addon.sh’s error line (CR 0028 R1)', async () => {
    const outcome = await run('rate-limited', { script: 'addon.sh', args: ['connect', 'bitwarden', '--instance', 'home', '--json'] });
    expect(outcome).toMatchObject({ kind: 'error', error: 'rate_limited', retryAfter: 42 });
  });
});

describe('runScriptJson', () => {
  const runJson = (fake: string) =>
    runScriptJson({ root, script: 'vault.sh', args: ['status', '--json'], env: { PATH: process.env.PATH, FAKE: fake, FAKE_DIR: root } });

  it('collects every JSON object line, with no phase key needed, and skips the rest', async () => {
    const outcome = await runJson('status');
    expect(outcome.code).toBe(0);
    expect(outcome.objects).toEqual([
      { slug: 'home', mode: 'cloud', scope: 'folder:Agent', unlock: 'manual', state: 'locked', error: null, retry_after: null },
      { file: 'x.env', slug: null, state: 'refused', error: 'bad_file' },
    ]);
    expect(fs.readFileSync(path.join(root, 'stdin'), 'utf8')).toBe('');
  });

  it('reports the exit code and stderr when the broker is down', async () => {
    expect(await runJson('broker-down')).toEqual({
      code: 1,
      objects: [],
      logTail: ['[vault] ERROR: the Bitwarden broker is not running'],
    });
  });
});

describe('runAddonScriptPlain', () => {
  const plain = (fake: string, extra: Partial<Parameters<typeof runAddonScriptPlain>[0]> = {}) =>
    runAddonScriptPlain({
      root,
      script: 'addon.sh',
      args: ['run', 'email', 'mailboxes'],
      env: { PATH: process.env.PATH, FAKE: fake, FAKE_DIR: root },
      ...extra,
    });

  it('returns the whole indented JSON stdout and exit code', async () => {
    const outcome = await plain('mailboxes');
    expect(outcome.code).toBe(0);
    expect(JSON.parse(outcome.stdout)).toEqual([{ name: 'INBOX', messages: 3 }]);
    expect(outcome.stdout).toContain('\n  {\n');
    expect(outcome.stderrTail).toEqual([]);
  });

  it('redacts an input value from stdout and stderr', async () => {
    const outcome = await plain('plain-leak', { input: { password: 'hunter2-secret' } });
    expect(outcome.code).toBe(2);
    expect(JSON.stringify(outcome)).not.toContain('hunter2-secret');
    expect(outcome.stdout).toContain('[redacted]');
    expect(outcome.stderrTail.join('\n')).toContain('[redacted]');
  });

  it('redacts the JSON-escaped form of a password with quotes and unicode', async () => {
    const password = 'a"b\\c ünï';
    const outcome = await plain('plain-leak', { input: { password } });
    expect(outcome.stdout).not.toContain(password);
    expect(outcome.stdout).not.toContain(JSON.stringify(password).slice(1, -1));
    expect(outcome.stderrTail.join('\n')).not.toContain(JSON.stringify(password).slice(1, -1));
  });

  it('reports 124 and a timeout line when the script runs past timeoutMs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = plain('slow', { timeoutMs: 60_000 });
      vi.advanceTimersByTime(60_000);
      const outcome = await pending;
      expect(outcome.code).toBe(124);
      expect(outcome.stderrTail.at(-1)).toBe('addon.sh run ran for more than 60 s and was stopped.');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('redact', () => {
  it('replaces every copy of each secret', () => {
    expect(redact('a s3cr3t b s3cr3t', ['s3cr3t'])).toBe('a [redacted] b [redacted]');
  });
});
