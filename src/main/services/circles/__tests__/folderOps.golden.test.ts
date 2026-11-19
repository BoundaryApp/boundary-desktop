import { describe, expect, it } from 'vitest';
import { applyFolderNodes, type FolderDeviceIntro, type FolderHost, type FolderOp, type FolderView } from '../folderOps';

/**
 * Pins what each folder format does. Anyone who adds a folder replays its whole log, so if this
 * fails, every peer on an older build disagrees with this one. Don't update the file to make it
 * pass: put the change behind a new format (ADR 0038, ADR 0049 §6) and add a log for it here.
 */

const hex = (char: string, length = 64) => char.repeat(length);

function intro(identity: string, writer: string, blobs: string, name: string): FolderDeviceIntro {
  return { identity: hex(identity), name, device: hex(identity), writer: hex(writer), blobs: hex(blobs), signature: hex(identity, 128) };
}

const ada = intro('a', 'b', 'c', 'Ada');
const bo = intro('1', '2', '3', 'Bo');
const cy = intro('4', '5', '6', 'Cy');
const di = intro('7', '8', '9', 'Di');

const put = (who: FolderDeviceIntro, path: string, base: number | null, at: number, size = 10): FolderOp => ({
  type: 'put',
  path,
  base,
  blob: { core: who.blobs, blockOffset: at % 7, blockLength: 1, byteOffset: at, byteLength: size },
  size,
  hash: hex('e'),
  at,
});

const LOG: Array<[FolderDeviceIntro, FolderOp]> = [
  [bo, { type: 'create', name: 'Not theirs', format: 1, role: 'editor', member: ada }],
  [ada, { type: 'create', name: ' Cover art ', format: 1, role: 'editor', member: ada }],
  [ada, { type: 'add-writer', member: bo }],
  [ada, { type: 'add-writer', member: bo }],
  [bo, { type: 'add-writer', member: cy }],
  [ada, { type: 'add-writer', member: cy }],
  [ada, { type: 'set-role', identity: di.identity, name: 'Di', role: 'reader' }],
  [ada, { type: 'add-writer', member: di }],
  [ada, put(ada, 'brief.md', null, 100)],
  [bo, put(bo, 'Brief.md', 1, 110)],
  [cy, put(cy, 'brief.md', 1, 120)],
  [cy, put(cy, 'brief.md', 1, 130)],
  [ada, put(ada, 'covers/option-1.png', null, 140, 18_000_000)],
  [bo, put(bo, 'covers/option-1.png', null, 150, 18_000_001)],
  [ada, put(ada, 'Résumé.md', null, 160)],
  [bo, put(bo, '.env', null, 170)],
  [bo, put(bo, 'a/../b.md', null, 170)],
  [bo, put(bo, 'mine.md', null, 170, 0)],
  [bo, { ...(put(bo, 'theirs.md', null, 180) as Extract<FolderOp, { type: 'put' }>), blob: { core: ada.blobs, blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 10 } }],
  [ada, { type: 'del', path: 'mine.md', base: 1, at: 190 }],
  [bo, put(bo, 'mine.md', 1, 200)],
  [cy, { type: 'del', path: 'brief.md', base: 1, at: 210 }],
  [ada, { type: 'set-role', identity: bo.identity, role: 'manager' }],
  [bo, { type: 'set-role', identity: ada.identity, role: 'editor' }],
  [ada, { type: 'set-role', identity: cy.identity, role: 'reader' }],
  [cy, put(cy, 'late.md', null, 220)],
  [ada, { type: 'set-format', format: 1 }],
  [ada, { type: 'remove-person', identity: bo.identity }],
  [bo, { type: 'remove-person', identity: bo.identity }],
  [bo, { type: 'paint-it-red' } as unknown as FolderOp],
];

async function replay(log: Array<[FolderDeviceIntro, FolderOp]>) {
  const data = new Map<string, unknown>();
  const view: FolderView = {
    get: async (key) => (data.has(key) ? { value: data.get(key) } : null),
    put: async (key, value) => void data.set(key, value),
    del: async (key) => void data.delete(key),
    list: async (prefix) =>
      [...data.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => data.get(key)),
  };
  const writers: Array<[string, string, boolean?]> = [];
  const host: FolderHost = {
    addWriter: async (key, { indexer }) => void writers.push(['add', key.toString('hex'), indexer]),
    removeWriter: async (key) => void writers.push(['remove', key.toString('hex')]),
    removeable: () => true,
    interrupt: () => {
      throw new Error('this log never stops');
    },
  };
  const skipped: string[] = [];
  await applyFolderNodes(
    log.map(([author, value]) => ({ value, from: { key: Buffer.from(author.writer, 'hex') } })),
    view,
    host,
    { verify: (_message, signature, publicKey) => signature[0] === publicKey[0], onSkip: (reason) => skipped.push(reason) }
  );
  const result = { view: Object.fromEntries([...data].sort(([a], [b]) => (a < b ? -1 : 1))), writers, skipped };
  return `${JSON.stringify(result, null, 2)}\n`;
}

describe('folder format 1', () => {
  it('turns this log into this view', async () => {
    await expect(await replay(LOG)).toMatchFileSnapshot('./fixtures/folderOpsFormat1.json');
  });
});
