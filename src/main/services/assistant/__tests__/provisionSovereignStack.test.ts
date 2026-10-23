import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE,
  SOVEREIGN_AGENT_STACK_REF,
} from '../../../../shared/assistantStackConstants';

describe('provisionSovereignStack', () => {
  let zipFixture: string | null = null;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (zipFixture) {
      fs.rmSync(path.dirname(zipFixture), { recursive: true, force: true });
      zipFixture = null;
    }
  });

  function buildFixtureZip(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sas-fixture-'));
    const tree = path.join(dir, 'sovereign-agent-stack-fixture');
    fs.mkdirSync(path.join(tree, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tree, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE), 'services: {}\n');
    fs.writeFileSync(path.join(tree, 'scripts', 'setup.sh'), '#!/bin/bash\necho ok\n', {
      mode: 0o755,
    });
    const zipPath = path.join(dir, 'stack.zip');
    execFileSync('zip', ['-qr', zipPath, 'sovereign-agent-stack-fixture'], { cwd: dir });
    zipFixture = zipPath;
    return zipPath;
  }

  it('asks for an image build once per tree', async () => {
    const {
      markHostSetupComplete,
      markImagesBuilt,
      needsImageBuild,
      resetBoundaryAssistantStack,
      writeProvisionMarker,
    } = await import('../provisionSovereignStack');
    await resetBoundaryAssistantStack({ wipeWorkspace: true });
    expect(needsImageBuild()).toBe(false);

    await writeProvisionMarker({ projectRef: 'old', hostSetupComplete: true });
    expect(needsImageBuild()).toBe(true);
    await markImagesBuilt();
    expect(needsImageBuild()).toBe(false);
    // Other marker writes keep it.
    await markHostSetupComplete();
    expect(needsImageBuild()).toBe(false);

    // A new tree (pin change) needs a build again.
    await writeProvisionMarker({ projectRef: 'new', hostSetupComplete: false });
    expect(needsImageBuild()).toBe(true);
  });

  it('extracts archive into project and writes provision marker', async () => {
    const zipPath = buildFixtureZip();
    const zipBytes = fs.readFileSync(zipPath);

    const fetchImpl = vi.fn(async () => {
      return new Response(zipBytes, {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      });
    }) as unknown as typeof fetch;

    const {
      ensureSovereignProjectProvisioned,
      readProvisionMarker,
      resetBoundaryAssistantStack,
    } = await import('../provisionSovereignStack');
    const { resolveAssistantProjectRoot } = await import('../assistantPaths');

    await resetBoundaryAssistantStack({ wipeWorkspace: true });

    const root = await ensureSovereignProjectProvisioned({
      ref: SOVEREIGN_AGENT_STACK_REF,
      fetchImpl,
      archiveSha256: createHash('sha256').update(zipBytes).digest('hex'),
    });

    expect(root).toBe(resolveAssistantProjectRoot());
    expect(fs.existsSync(path.join(root, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE))).toBe(true);
    expect(fs.existsSync(path.join(root, 'scripts', 'setup.sh'))).toBe(true);

    const marker = readProvisionMarker();
    expect(marker?.projectRef).toBe(SOVEREIGN_AGENT_STACK_REF);
    expect(marker?.hostSetupComplete).toBe(false);

    // Second call should skip download when marker matches.
    fetchImpl.mockClear();
    await ensureSovereignProjectProvisioned({
      ref: SOVEREIGN_AGENT_STACK_REF,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an archive that does not match the pinned checksum', async () => {
    const zipBytes = fs.readFileSync(buildFixtureZip());
    const fetchImpl = vi.fn(
      async () => new Response(zipBytes, { status: 200 })
    ) as unknown as typeof fetch;
    const { ensureSovereignProjectProvisioned, resetBoundaryAssistantStack } = await import(
      '../provisionSovereignStack'
    );
    const { resolveAssistantProjectRoot } = await import('../assistantPaths');
    await resetBoundaryAssistantStack({ wipeWorkspace: true });

    // The pinned ref defaults to the pinned hash, which the fixture can't match.
    await expect(
      ensureSovereignProjectProvisioned({ ref: SOVEREIGN_AGENT_STACK_REF, fetchImpl })
    ).rejects.toThrow(/didn’t match its pinned checksum/);
    expect(fs.existsSync(resolveAssistantProjectRoot())).toBe(false);
  });

  it('moving to a new ref stops the stack and keeps data and secrets', async () => {
    const zipBytes = fs.readFileSync(buildFixtureZip());
    const fetchImpl = vi.fn(
      async () => new Response(zipBytes, { status: 200, headers: { 'Content-Type': 'application/zip' } })
    ) as unknown as typeof fetch;
    const { ensureSovereignProjectProvisioned, readProvisionMarker, resetBoundaryAssistantStack } =
      await import('../provisionSovereignStack');

    await resetBoundaryAssistantStack({ wipeWorkspace: true });
    const root = await ensureSovereignProjectProvisioned({ ref: 'old-ref', fetchImpl });
    fs.mkdirSync(path.join(root, 'data', 'hermes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'hermes', 'state.db'), 'chats');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=keep\n');

    const beforeReplace = vi.fn(async () => undefined);
    await ensureSovereignProjectProvisioned({ ref: 'new-ref', fetchImpl, beforeReplace });

    expect(beforeReplace).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(root, 'data', 'hermes', 'state.db'), 'utf8')).toBe('chats');
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('SECRET=keep\n');
    expect(readProvisionMarker()).toMatchObject({ projectRef: 'new-ref', hostSetupComplete: false });
  });

  it('leaves everything in place when the stack can’t be stopped', async () => {
    const zipBytes = fs.readFileSync(buildFixtureZip());
    const fetchImpl = vi.fn(
      async () => new Response(zipBytes, { status: 200, headers: { 'Content-Type': 'application/zip' } })
    ) as unknown as typeof fetch;
    const { ensureSovereignProjectProvisioned, readProvisionMarker, resetBoundaryAssistantStack } =
      await import('../provisionSovereignStack');

    await resetBoundaryAssistantStack({ wipeWorkspace: true });
    const root = await ensureSovereignProjectProvisioned({ ref: 'old-ref', fetchImpl });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'state.db'), 'chats');

    await expect(
      ensureSovereignProjectProvisioned({
        ref: 'new-ref',
        fetchImpl,
        beforeReplace: async () => {
          throw new Error('Docker is not running');
        },
      })
    ).rejects.toThrow(/Couldn’t stop the agent stack/);
    expect(fs.readFileSync(path.join(root, 'data', 'state.db'), 'utf8')).toBe('chats');
    expect(readProvisionMarker()?.projectRef).toBe('old-ref');
  });

  it('reports download percent when Content-Length is present', async () => {
    const { Readable } = await import('node:stream');
    const zipPath = buildFixtureZip();
    const zipBytes = fs.readFileSync(zipPath);
    const messages: string[] = [];

    const { __test } = await import('../provisionSovereignStack');
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sas-dl-')), 'out.zip');

    const body = Readable.from([zipBytes.subarray(0, Math.ceil(zipBytes.length / 2)), zipBytes.subarray(Math.ceil(zipBytes.length / 2))]);
    const fetchImpl = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-length' ? String(zipBytes.length) : null,
        },
        body,
      };
    }) as unknown as typeof fetch;

    await __test.downloadArchive('https://example.test/stack.zip', dest, fetchImpl, (m) =>
      messages.push(m)
    );

    expect(fs.existsSync(dest)).toBe(true);
    expect(messages.some((m) => /Downloading archive \d+%/.test(m))).toBe(true);
    expect(messages.at(-1)).toBe('Downloading archive 100%');
    fs.rmSync(path.dirname(dest), { recursive: true, force: true });
  });
});
