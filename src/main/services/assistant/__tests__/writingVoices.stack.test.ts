/**
 * Writing voices against the running stack (ADR 0056): the skill calibration asks for is on the
 * built-in agent's profile, Hermes may write under /opt/voice, and the skill's stats script runs.
 * Nothing here writes into the stack's data folder: the sample lives in a temp folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execInHermes, probeStack, skipNote, type StackTarget } from './stackHarness';

const probe = await probeStack();
const TEMP_PREFIX = '/tmp/boundary-voice-';
const SAMPLE = 'One short sentence here. Another one follows it, a little longer than the first.\n';

describe.skipIf(!probe.ok)(`Writing voices on the stack${skipNote(probe)}`, () => {
  const target = (probe.ok ? probe.target : null) as StackTarget;
  let dir = '';

  beforeAll(async () => {
    const made = await execInHermes(target, ['mktemp', '-d', `${TEMP_PREFIX}XXXXXX`]);
    dir = made.stdout.trim();
    if (made.code !== 0 || !dir.startsWith(TEMP_PREFIX)) throw new Error(`mktemp failed: ${made.stderr}`);
    const wrote = await execInHermes(
      target,
      ['sh', '-c', 'mkdir -p "$1/samples" && cat > "$1/samples/one.md"', 'sh', dir],
      { input: SAMPLE }
    );
    if (wrote.code !== 0) throw new Error(`sample write failed: ${wrote.stderr}`);
  });

  afterAll(async () => {
    if (dir.startsWith(TEMP_PREFIX)) await execInHermes(target, ['rm', '-rf', '--', dir]);
  });

  it('lists write-in-voice for the default profile', async () => {
    const run = await execInHermes(target, ['hermes', 'skills', 'list'], { env: { COLUMNS: '240' } });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('write-in-voice');
  });

  it('lets Hermes write under /opt/voice', async () => {
    const run = await execInHermes(target, ['printenv', 'HERMES_WRITE_SAFE_ROOT']);
    expect(run.stdout.trim().split(':')).toContain('/opt/voice');
  });

  it('runs the skill stats script on a samples folder', async () => {
    const run = await execInHermes(target, [
      'python3',
      '/opt/skills/write-in-voice/scripts/corpus-stats.py',
      `${dir}/samples`,
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/Files:\s+1\b/);
  });
});
