import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { promisify } from 'node:util';
import {
  BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE,
  SOVEREIGN_AGENT_STACK_ARCHIVE_SHA256,
  SOVEREIGN_AGENT_STACK_GITHUB_URL,
  SOVEREIGN_AGENT_STACK_REF,
  sovereignAgentStackArchiveUrl,
} from '../../../shared/assistantStackConstants';
import {
  resolveAssistantProjectRoot,
  resolveAssistantStackHome,
  resolveProvisionMarkerPath,
} from './assistantPaths';
import {
  isLocalAssistantStackMode,
  localStackResetBlockedMessage,
} from './localStackMode';
import {
  recoverInterruptedProjectSwap,
  swapProjectTreePreservingData,
} from './projectTreeSwap';
import { backupStackDataBeforeUpgrade } from './stackDataBackup';
import { persistDebugLog } from '../../persistDebugLog';

const execFileAsync = promisify(execFile);

export interface AssistantStackProvisionMarker {
  projectRef: string;
  hostSetupComplete: boolean;
  provisionedAt?: string;
  hostSetupAt?: string;
  /** The tree whose locally built images (llm-proxy, the worker, …) were last built. */
  imagesBuiltRef?: string;
}

export type ProvisionProgressCallback = (message: string) => void;

function looksLikeProjectRoot(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE));
}

export function readProvisionMarker(): AssistantStackProvisionMarker | null {
  const markerPath = resolveProvisionMarkerPath();
  if (!fs.existsSync(markerPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(markerPath, 'utf8');
    const parsed = JSON.parse(raw) as AssistantStackProvisionMarker;
    if (!parsed || typeof parsed.projectRef !== 'string') {
      return null;
    }
    return {
      projectRef: parsed.projectRef,
      hostSetupComplete: Boolean(parsed.hostSetupComplete),
      provisionedAt: parsed.provisionedAt,
      hostSetupAt: parsed.hostSetupAt,
      ...(typeof parsed.imagesBuiltRef === 'string'
        ? { imagesBuiltRef: parsed.imagesBuiltRef }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function writeProvisionMarker(
  partial: Partial<AssistantStackProvisionMarker> & { projectRef: string }
): Promise<void> {
  const home = resolveAssistantStackHome();
  await fs.promises.mkdir(home, { recursive: true });
  const existing = readProvisionMarker();
  const hostSetupComplete = partial.hostSetupComplete ?? existing?.hostSetupComplete ?? false;
  const next: AssistantStackProvisionMarker = {
    projectRef: partial.projectRef,
    hostSetupComplete,
    provisionedAt:
      partial.provisionedAt !== undefined ? partial.provisionedAt : existing?.provisionedAt,
    hostSetupAt: hostSetupComplete
      ? partial.hostSetupAt !== undefined
        ? partial.hostSetupAt
        : existing?.hostSetupAt
      : undefined,
    ...((partial.imagesBuiltRef ?? existing?.imagesBuiltRef)
      ? { imagesBuiltRef: partial.imagesBuiltRef ?? existing?.imagesBuiltRef }
      : {}),
  };
  await fs.promises.writeFile(
    resolveProvisionMarkerPath(),
    `${JSON.stringify(next, null, 2)}\n`,
    'utf8'
  );
}

/**
 * Compose builds a service's image only when it is missing, so after a pin change the
 * stack's locally built images (llm-proxy and others) would keep the old code. True until
 * images have been built from the current tree.
 */
export function needsImageBuild(): boolean {
  const marker = readProvisionMarker();
  return Boolean(marker) && marker.imagesBuiltRef !== marker.projectRef;
}

export async function markImagesBuilt(): Promise<void> {
  const marker = readProvisionMarker();
  if (!marker) return;
  await writeProvisionMarker({ projectRef: marker.projectRef, imagesBuiltRef: marker.projectRef });
}

export function isHostSetupComplete(): boolean {
  return Boolean(readProvisionMarker()?.hostSetupComplete);
}

export async function markHostSetupComplete(): Promise<void> {
  const marker = readProvisionMarker();
  const projectRef = marker?.projectRef ?? SOVEREIGN_AGENT_STACK_REF;
  await writeProvisionMarker({
    projectRef,
    hostSetupComplete: true,
    hostSetupAt: new Date().toISOString(),
    provisionedAt: marker?.provisionedAt ?? new Date().toISOString(),
  });
}

export async function clearHostSetupComplete(): Promise<void> {
  const marker = readProvisionMarker();
  if (!marker) return;
  await writeProvisionMarker({
    ...marker,
    hostSetupComplete: false,
    hostSetupAt: undefined,
  });
}

function resolveUpgradeJournalPath(): string {
  return path.join(resolveAssistantStackHome(), '.upgrade.json');
}

/** Holds the data backup from the last pin move (stackDataBackup.ts). */
export function resolveUpgradeBackupsRoot(): string {
  return path.join(resolveAssistantStackHome(), 'backups');
}

function resolvePreviousProjectRoot(): string {
  return path.join(resolveAssistantStackHome(), 'project.previous');
}

/**
 * Download and extract the pinned sovereign-agent-stack archive into userData/project.
 * Skips download when project already has compose + matching provision marker ref.
 *
 * Moving to a new ref keeps the user's data and generated secrets (see
 * PRESERVED_PROJECT_PATHS): `beforeReplace` stops the running stack, the data a release may
 * migrate is backed up (stackDataBackup.ts), the new tree is swapped in, and setup.sh
 * re-runs to fill in anything the new stack needs.
 */
export async function ensureSovereignProjectProvisioned(
  options: {
    ref?: string;
    /** Called before an existing tree is replaced, e.g. to stop the stack running from it. */
    beforeReplace?: () => Promise<void>;
    onProgress?: ProvisionProgressCallback;
    fetchImpl?: typeof fetch;
    /**
     * Expected SHA-256 of the archive. Defaults to the pinned hash for the pinned ref;
     * null skips the check (another ref, set only by tests).
     */
    archiveSha256?: string | null;
  } = {}
): Promise<string> {
  const ref = options.ref ?? SOVEREIGN_AGENT_STACK_REF;
  const archiveSha256 =
    options.archiveSha256 !== undefined
      ? options.archiveSha256
      : ref === SOVEREIGN_AGENT_STACK_REF
        ? SOVEREIGN_AGENT_STACK_ARCHIVE_SHA256
        : null;
  const onProgress = options.onProgress;
  const projectRoot = resolveAssistantProjectRoot();
  const journalPath = resolveUpgradeJournalPath();

  if (await recoverInterruptedProjectSwap(journalPath)) {
    onProgress?.('Finished an interrupted agent stack upgrade.');
  }
  const marker = readProvisionMarker();

  if (
    looksLikeProjectRoot(projectRoot) &&
    marker?.projectRef === ref &&
    fs.existsSync(path.join(projectRoot, 'scripts', 'setup.sh'))
  ) {
    return projectRoot;
  }

  onProgress?.(
    `Downloading ${SOVEREIGN_AGENT_STACK_GITHUB_URL} @ ${ref.slice(0, 12)}…`
  );

  const home = resolveAssistantStackHome();
  await fs.promises.mkdir(home, { recursive: true });

  // Stage beside the project so the swap is a rename on one volume, not a copy of data/.
  const tmpDir = await fs.promises.mkdtemp(path.join(home, '.staging-'));
  const zipPath = path.join(tmpDir, 'stack.zip');
  const extractDir = path.join(tmpDir, 'extract');

  try {
    await downloadArchive(
      sovereignAgentStackArchiveUrl(ref),
      zipPath,
      options.fetchImpl,
      onProgress
    );
    if (archiveSha256) {
      await verifyArchiveSha256(zipPath, archiveSha256, sovereignAgentStackArchiveUrl(ref));
    }
    await fs.promises.mkdir(extractDir, { recursive: true });
    onProgress?.('Extracting agent stack archive…');
    await execFileAsync('unzip', ['-q', '-o', zipPath, '-d', extractDir]);

    const entries = await fs.promises.readdir(extractDir, { withFileTypes: true });
    const top = entries.find((e) => e.isDirectory());
    if (!top) {
      throw new Error('Agent stack archive did not contain a top-level directory.');
    }
    const extractedRoot = path.join(extractDir, top.name);
    if (!looksLikeProjectRoot(extractedRoot)) {
      throw new Error(
        `Extracted archive is missing ${BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE}.`
      );
    }

    if (fs.existsSync(projectRoot)) {
      onProgress?.('Stopping the agent stack to upgrade it…');
      try {
        await options.beforeReplace?.();
      } catch (error) {
        // Don't move data out from under running containers. A tree compose can't
        // read has nothing running from it, so carry on in that case.
        if (looksLikeProjectRoot(projectRoot)) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Couldn’t stop the agent stack before upgrading it: ${message}`);
        }
      }
      // A new release can migrate data in place with no way back (n8n's database, Hermes
      // state), so keep a copy from before the move.
      onProgress?.('Backing up agent data before the upgrade…');
      const backup = await backupStackDataBeforeUpgrade({
        dataRoot: path.join(projectRoot, 'data'),
        backupsRoot: resolveUpgradeBackupsRoot(),
        name: `data-at-${(marker?.projectRef ?? 'unknown').slice(0, 12)}`,
      });
      if (backup) onProgress?.(`Backed up agent data to ${backup}.`);
      onProgress?.('Upgrading the agent stack and keeping your data…');
      await swapProjectTreePreservingData({
        projectRoot,
        nextRoot: extractedRoot,
        previousRoot: resolvePreviousProjectRoot(),
        journalPath,
      });
    } else {
      await fs.promises.mkdir(path.dirname(projectRoot), { recursive: true });
      await fs.promises.rename(extractedRoot, projectRoot);
    }

    await writeProvisionMarker({
      projectRef: ref,
      // A new tree needs setup.sh again; it keeps existing secrets and adds new ones.
      hostSetupComplete: false,
      provisionedAt: new Date().toISOString(),
      hostSetupAt: undefined,
    });

    onProgress?.('Agent stack project ready.');
    return projectRoot;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch((): undefined => undefined);
  }
}

async function verifyArchiveSha256(
  filePath: string,
  expected: string,
  url: string
): Promise<void> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  const actual = hash.digest('hex');
  if (actual !== expected.toLowerCase()) {
    persistDebugLog('assistant-stack', 'agent stack archive checksum mismatch', {
      url,
      expected,
      actual,
    });
    throw new Error(
      `The agent stack download didn’t match its pinned checksum (expected ${expected}, got ${actual}): ${url}`
    );
  }
}

async function downloadArchive(
  url: string,
  destPath: string,
  fetchImpl: typeof fetch = fetch,
  onProgress?: ProvisionProgressCallback
): Promise<void> {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'Boundary-Desktop' },
    redirect: 'follow',
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download agent stack archive (${response.status} ${response.statusText}): ${url}`
    );
  }

  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : 0;
  const hasLength = Number.isFinite(contentLength) && contentLength > 0;

  // Node fetch body is a web ReadableStream; convert via Response arrayBuffer for simplicity
  // on large-ish repos, or pipe if available.
  const nodeBody = response.body as unknown as NodeJS.ReadableStream | null;
  if (nodeBody && typeof (nodeBody as { pipe?: unknown }).pipe === 'function') {
    let received = 0;
    let lastEmit = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        const now = Date.now();
        if (onProgress && hasLength && now - lastEmit >= 250) {
          lastEmit = now;
          const pct = Math.min(99, Math.round((received / contentLength) * 100));
          onProgress(`Downloading archive ${pct}%`);
        } else if (onProgress && !hasLength && now - lastEmit >= 2_000) {
          lastEmit = now;
          const mb = (received / (1024 * 1024)).toFixed(1);
          onProgress(`Downloading archive… ${mb} MB`);
        }
        cb(null, chunk);
      },
    });
    await pipeline(nodeBody, counter, createWriteStream(destPath));
    if (onProgress && hasLength) {
      onProgress('Downloading archive 100%');
    }
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(destPath, buffer);
  if (onProgress && hasLength) {
    onProgress('Downloading archive 100%');
  }
}

/**
 * Wipe Boundary-owned project + markers so the next ensure behaves like first launch.
 * Does not touch developer checkouts or BOUNDARY_ASSISTANT_ROOT overrides.
 * Refuses entirely while local-stack mode is active.
 */
export async function resetBoundaryAssistantStack(options?: {
  wipeWorkspace?: boolean;
}): Promise<void> {
  if (isLocalAssistantStackMode()) {
    throw new Error(localStackResetBlockedMessage('Assistant stack reset'));
  }

  const home = resolveAssistantStackHome();
  const projectRoot = resolveAssistantProjectRoot();
  await fs.promises.rm(projectRoot, { recursive: true, force: true });
  await fs.promises.rm(resolvePreviousProjectRoot(), { recursive: true, force: true });
  await fs.promises.rm(resolveUpgradeJournalPath(), { force: true });
  await fs.promises.rm(resolveUpgradeBackupsRoot(), { recursive: true, force: true });
  await fs.promises.rm(resolveProvisionMarkerPath(), { force: true });
  if (options?.wipeWorkspace) {
    await fs.promises.rm(path.join(home, 'workspace'), { recursive: true, force: true });
  }
  // Leave empty home so subsequent provision recreates cleanly.
  await fs.promises.mkdir(home, { recursive: true });
}

/** Exported for tests */
export const __test = {
  looksLikeProjectRoot,
  downloadArchive,
};
