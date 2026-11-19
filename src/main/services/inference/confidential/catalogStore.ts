import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfidentialCatalog } from '../../../../shared/types/confidential';
import { parseCatalog, type CatalogDrop } from './catalog';
import { createSerialQueue } from '../../../../shared/utils/serialQueue';

/**
 * Fetches, verifies and keeps Boundary's signed confidential provider catalog (ADR 0047 §4).
 * Only a catalog whose detached Ed25519 signature matches the pinned key, that parses, and that
 * is newer than the one kept is written. The copy on disk is verified again when loaded, so an
 * edited file is ignored. An older catalog with a valid signature is refused, so a replayed old
 * list can't put back old prices or trust levels.
 *
 * The kept catalog and its signature share one file, replaced by a single rename, so a crash
 * can't leave a body with another catalog's signature. Refreshes run one at a time, and each
 * fetch gives up after `CATALOG_FETCH_TIMEOUT_MS`, so a hung server can't hold the queue.
 */

/** Prices older than this, measured from the catalog's `publishedAt`, are marked stale. */
export const CATALOG_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** How long one refresh waits for the catalog and its signature. */
export const CATALOG_FETCH_TIMEOUT_MS = 30_000;

/** `{ body: base64 of the exact signed bytes, signature: base64 }`. */
const CATALOG_FILE = 'confidential-catalog.json';

export type CatalogRefreshStatus = 'updated' | 'unchanged' | 'bad-signature' | 'rollback' | 'invalid' | 'unreachable';

export interface CatalogSnapshot {
  catalog: ConfidentialCatalog | null;
  publishedAt: string | null;
  stale: boolean;
  lastRefresh: { status: CatalogRefreshStatus; at: number } | null;
  dropped: CatalogDrop[];
}

export interface CatalogStoreOptions {
  dir: string;
  url: string;
  publicKeyPem: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Metadata only: status and dates. */
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** True when `signatureBase64` is a valid Ed25519 signature of `body` under the key. Never throws. */
export function verifyCatalogSignature(body: Buffer, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    const signature = Buffer.from(signatureBase64.trim(), 'base64');
    if (signature.length === 0) return false;
    return verify(null, body, createPublicKey(publicKeyPem), signature);
  } catch {
    return false;
  }
}

type Checked =
  | { ok: true; catalog: ConfidentialCatalog; dropped: CatalogDrop[] }
  | { ok: false; status: 'bad-signature' | 'invalid' };

export class CatalogStore {
  private catalog: ConfidentialCatalog | null = null;
  private dropped: CatalogDrop[] = [];
  private lastRefresh: CatalogSnapshot['lastRefresh'] = null;
  private loaded = false;
  private readonly serial = createSerialQueue();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: CatalogStoreOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  snapshot(): CatalogSnapshot {
    const publishedAt = this.catalog?.publishedAt ?? null;
    return {
      catalog: this.catalog,
      publishedAt,
      stale: publishedAt !== null && this.now() - Date.parse(publishedAt) > CATALOG_STALE_AFTER_MS,
      lastRefresh: this.lastRefresh,
      dropped: this.dropped,
    };
  }

  /** Reads the kept catalog. A missing pair of files is no catalog; a mismatched pair is ignored. */
  async load(): Promise<CatalogSnapshot> {
    this.loaded = true;
    let body: Buffer;
    let signature: string;
    try {
      const envelope = JSON.parse(await readFile(join(this.opts.dir, CATALOG_FILE), 'utf8')) as unknown;
      if (
        typeof envelope !== 'object' ||
        envelope === null ||
        typeof (envelope as { body?: unknown }).body !== 'string' ||
        typeof (envelope as { signature?: unknown }).signature !== 'string'
      ) {
        this.record('bad-signature');
        return this.snapshot();
      }
      body = Buffer.from((envelope as { body: string }).body, 'base64');
      signature = (envelope as { signature: string }).signature;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.record('bad-signature');
      return this.snapshot();
    }
    const checked = this.check(body, signature);
    if (checked.ok === false) {
      this.record(checked.status);
    } else {
      this.catalog = checked.catalog;
      this.dropped = checked.dropped;
    }
    return this.snapshot();
  }

  /** Runs after any refresh already in progress, so each compares against the last one's result. */
  refresh(): Promise<CatalogSnapshot> {
    return this.serial(() => this.refreshNow());
  }

  /** Loads the kept copy first if nothing has, so the rollback check always has it to compare. */
  private async refreshNow(): Promise<CatalogSnapshot> {
    if (!this.loaded) await this.load();
    let body: Buffer;
    let signature: string;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);
    try {
      const [bodyRes, signatureRes] = await Promise.all([
        this.fetchImpl(this.opts.url, { signal: controller.signal }),
        this.fetchImpl(`${this.opts.url}.sig`, { signal: controller.signal }),
      ]);
      if (!bodyRes.ok || !signatureRes.ok) return this.record('unreachable');
      body = Buffer.from(await bodyRes.arrayBuffer());
      signature = await signatureRes.text();
    } catch {
      return this.record('unreachable');
    } finally {
      clearTimeout(timer);
    }
    const checked = this.check(body, signature);
    if (checked.ok === false) return this.record(checked.status);
    const kept = this.catalog ? Date.parse(this.catalog.publishedAt) : null;
    const offered = Date.parse(checked.catalog.publishedAt);
    if (kept !== null && offered === kept) return this.record('unchanged');
    if (kept !== null && offered < kept) return this.record('rollback');
    await this.write(body, signature);
    this.catalog = checked.catalog;
    this.dropped = checked.dropped;
    return this.record('updated');
  }

  private check(body: Buffer, signature: string): Checked {
    if (!verifyCatalogSignature(body, signature, this.opts.publicKeyPem)) return { ok: false, status: 'bad-signature' };
    let value: unknown;
    try {
      value = JSON.parse(body.toString('utf8'));
    } catch {
      return { ok: false, status: 'invalid' };
    }
    const parsed = parseCatalog(value);
    return parsed.ok ? parsed : { ok: false, status: 'invalid' };
  }

  /** Writes the envelope beside its final name, then renames it into place in one step. */
  private async write(body: Buffer, signature: string): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    const path = join(this.opts.dir, CATALOG_FILE);
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ body: body.toString('base64'), signature: signature.trim() }));
    await rename(temp, path);
  }

  private record(status: CatalogRefreshStatus): CatalogSnapshot {
    this.lastRefresh = { status, at: this.now() };
    this.opts.log?.('confidential catalog', { status, publishedAt: this.catalog?.publishedAt ?? null });
    return this.snapshot();
  }
}
