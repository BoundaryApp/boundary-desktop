/**
 * Stack contract: the AI text detector add-on (CR 0030, stack v0.3.14; writing check spec,
 * phase 5).
 *
 * Costs nothing and sends nothing off the Mac: the only check it posts is under 50 words, which
 * the add-on refuses as `too_short` before any provider call. Skipped unless the stack has the
 * add-on turned on with its token written (`addon.sh enable detector`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveAssistantUserContentRoot } from '../assistantPaths';
import { checkWithDetector, detectorStatus, type DetectorDeps } from '../writingCheck/detectorClient';
import { probeStack, skipNote } from './stackHarness';

const probe = await probeStack();
const root = probe.ok ? probe.target.root : '';

const deps = (dataRoot?: string): DetectorDeps => ({
  stackRoot: () => root,
  dataRoot: (r) => dataRoot ?? resolveAssistantUserContentRoot(r),
  fetch: (...args) => globalThis.fetch(...args),
  consent: { has: () => false, add: () => undefined },
});

const status = probe.ok ? await detectorStatus(deps()) : { available: false as const };
const ready = status.available;
const note =
  probe.ok && !ready ? ' (skipped: the detector add-on is not on, or has no token)' : skipNote(probe);

const wrongTokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-wrong-token-'));

describe.skipIf(!ready)(`Detector add-on${note}`, () => {
  afterAll(() => fs.rmSync(wrongTokenRoot, { recursive: true, force: true }));

  it('answers /health with a known provider and declares what leaves the Mac', () => {
    expect(status).toMatchObject({ available: true });
    if (!status.available) return;
    expect(['pangram', 'gptzero']).toContain(status.provider);
    expect(status.dataLeaves.length).toBeGreaterThan(0);
  });

  it('refuses text under 50 words as too_short, before any provider call', async () => {
    const result = await checkWithDetector('Too short to send anywhere.', deps());
    expect(result).toMatchObject({ ok: false, error: { code: 'too_short' } });
  });

  it('refuses a wrong token', async () => {
    const secrets = path.join(wrongTokenRoot, 'addons', 'detector', 'secrets');
    fs.mkdirSync(secrets, { recursive: true });
    fs.writeFileSync(path.join(secrets, 'http_token'), '0'.repeat(64));
    const result = await checkWithDetector('Too short to send anywhere.', deps(wrongTokenRoot));
    expect(result).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });
});
