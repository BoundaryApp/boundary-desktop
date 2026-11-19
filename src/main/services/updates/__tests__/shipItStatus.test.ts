import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLaunchdJob, parseShipItLog, readShipItStatus } from '../shipItStatus';

const HOME = '/Users/someone';
const line = (text: string) => `2026-11-07 03:05:49.478 ShipIt[1409:5574011] ${text}`;

// Lines as Squirrel.Mac's ShipIt writes them, from a successful install on a signed build.
const INSTALLED = [
  line('Detected this as an install request'),
  `ERROR: Unrecognized attribute string flag '?' in attribute string "T@"NSString",?,R,C" for property debugDescription`,
  line('Beginning installation'),
  line(`Couldn't remove owned bundle at location file:///var/folders/xx/T/com.example.ShipIt.abc/Example.app, error NSError`),
  line('Installation completed successfully'),
  line('Detected this as a launch request'),
  line('Successfully launched application at file:///Applications/Example.app/'),
  line('ShipIt quitting'),
].join('\n');

describe('parseShipItLog', () => {
  it('reports a finished install, ignoring the cleanup and attribute noise around it', () => {
    expect(parseShipItLog(INSTALLED, HOME)).toEqual({ outcome: 'installed', attempts: 0, detail: null });
  });

  it('reports the retries and the give-up of an install that kept failing', () => {
    const log = [
      INSTALLED,
      line('Detected this as an install request'),
      line('Beginning installation'),
      line(`Installation error: Error Domain=NSCocoaErrorDomain Code=513 "Boundary.app" couldn't be moved`),
      line('Detected this as an install request'),
      line('Resuming installation attempt 2'),
      line('Detected this as an install request'),
      line('Resuming installation attempt 3'),
      line('Too many attempts to install, aborting update'),
    ].join('\n');
    expect(parseShipItLog(log, HOME)).toEqual({
      outcome: 'gave-up',
      attempts: 3,
      detail: 'Too many attempts to install, aborting update',
    });
  });

  it('reports an install held back by a running copy of the app', () => {
    const log = line('Aborting update attempt because there are 2 running instances of the target app');
    expect(parseShipItLog(log, HOME)).toMatchObject({ outcome: 'app-running', attempts: 0 });
  });

  it('reports an install that started and has no result yet', () => {
    const log = [INSTALLED, line('Detected this as an install request'), line('Beginning installation')].join('\n');
    expect(parseShipItLog(log, HOME)).toEqual({ outcome: 'started', attempts: 0, detail: null });
  });

  it('keeps the error text, with the home folder shortened and long lines cut', () => {
    const path = `${HOME}/Library/Caches/com.example.ShipIt/update.abc/Example.app`;
    const log = line(`Installation error: could not move ${path} ${'x'.repeat(400)}`);
    const result = parseShipItLog(log, HOME);
    expect(result.outcome).toBe('error');
    expect(result.detail).toMatch(/^Installation error: could not move ~\/Library\/Caches\//);
    expect(result.detail).not.toContain(HOME);
    expect(result.detail!.length).toBeLessThanOrEqual(300);
  });

  it('reports a missing update bundle', () => {
    const log = line('Update bundle file:///Users/someone/x.app no longer exists, aborting update');
    expect(parseShipItLog(log, HOME)).toMatchObject({
      outcome: 'update-missing',
      detail: 'Update bundle file://~/x.app no longer exists, aborting update',
    });
  });

  it('has no outcome for an empty log', () => {
    expect(parseShipItLog('', HOME)).toEqual({ outcome: null, attempts: 0, detail: null });
  });
});

describe('parseLaunchdJob', () => {
  // Trimmed from `launchctl print gui/<uid>/<label>` on macOS 26.
  const PRINT = `gui/501/com.example.ShipIt = {
	active count = 0
	path = (submitted by Example[1208])
	type = Submitted
	state = not running

	program = /Applications/Example.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt
	runs = 1
	last exit code = 0

	event triggers = {
	}
	keepalive = {
		successful exit => 0
	}
}`;

  it('reads the state, run count and last exit code', () => {
    expect(parseLaunchdJob(PRINT)).toEqual({ state: 'not running', runs: 1, lastExit: 0 });
  });

  it('reads a running job, which has no exit code yet', () => {
    const running = PRINT.replace('state = not running', 'state = running').replace(/\tlast exit code = 0\n/, '\tlast exit code = (never exited)\n');
    expect(parseLaunchdJob(running)).toEqual({ state: 'running', runs: 1, lastExit: null });
  });
});

describe('readShipItStatus', () => {
  let caches: string;

  beforeEach(async () => {
    caches = await mkdtemp(join(tmpdir(), 'shipit-status-'));
  });
  afterEach(() => rm(caches, { recursive: true, force: true }));

  it('returns null when ShipIt has never run for this app', async () => {
    const printJob = vi.fn();
    expect(await readShipItStatus({ bundleId: 'com.example', caches, home: HOME, printJob })).toBeNull();
    expect(printJob).not.toHaveBeenCalled();
  });

  it('combines the job and the end of the log', async () => {
    const dir = join(caches, 'com.example.ShipIt');
    await mkdir(dir);
    await writeFile(join(dir, 'ShipIt_stderr.log'), INSTALLED);
    const printJob = vi.fn(async () => 'state = not running\nruns = 1\nlast exit code = 0\n');
    const status = await readShipItStatus({ bundleId: 'com.example', caches, home: HOME, printJob });
    expect(printJob).toHaveBeenCalledWith('com.example.ShipIt');
    expect(status).toMatchObject({
      job: { state: 'not running', runs: 1, lastExit: 0 },
      outcome: 'installed',
      attempts: 0,
      detail: null,
    });
    expect(typeof status?.logUpdatedAt).toBe('string');
  });

  it('reports no job when launchd has none, and reads only the end of a long log', async () => {
    const dir = join(caches, 'com.example.ShipIt');
    await mkdir(dir);
    const old = line('Installation error: an old failure') + '\n';
    await writeFile(join(dir, 'ShipIt_stderr.log'), old.repeat(5000) + INSTALLED);
    const printJob = vi.fn(async () => {
      throw new Error('Could not find service');
    });
    const status = await readShipItStatus({ bundleId: 'com.example', caches, home: HOME, printJob });
    expect(status).toMatchObject({ job: null, outcome: 'installed' });
  });

  it('still reports the job when the log is missing', async () => {
    await mkdir(join(caches, 'com.example.ShipIt'));
    const printJob = vi.fn(async () => 'state = running\nruns = 2\n');
    const status = await readShipItStatus({ bundleId: 'com.example', caches, home: HOME, printJob });
    expect(status).toEqual({
      job: { state: 'running', runs: 2, lastExit: null },
      logUpdatedAt: null,
      outcome: null,
      attempts: 0,
      detail: null,
    });
  });
});
