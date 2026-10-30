import fs from 'node:fs';
import path from 'node:path';

/**
 * Data under the stack's `data/` that a new release may migrate in place, with no way back:
 * Hermes state (stack v0.3.3 moves Hermes to v0.22), n8n's SQLite store (n8n 2.x migrates it
 * forward on first start), LightRAG's storage and graph, and the shared Postgres cluster, which
 * the stopped containers leave consistent on disk. The stack's CHANGELOG asks for a copy of
 * each, taken with the containers stopped, before the pin moves.
 */
const UPGRADE_BACKUP_DATA_DIRS: readonly string[] = ['hermes', 'n8n', 'rag_storage', 'neo4j', 'db'];

/**
 * Copy the data directories in {@link UPGRADE_BACKUP_DATA_DIRS} to `<backupsRoot>/<name>`,
 * then delete older backups there, so one backup (from the last pin move) is kept. Files are
 * cloned where the volume supports it (APFS), so the copy costs little space until the data
 * changes. Sockets and FIFOs are skipped. Containers must be stopped first.
 *
 * Returns the backup directory, or null when there was no data to copy.
 */
export async function backupStackDataBeforeUpgrade(options: {
  dataRoot: string;
  backupsRoot: string;
  name: string;
}): Promise<string | null> {
  const { dataRoot, backupsRoot, name } = options;
  const present = UPGRADE_BACKUP_DATA_DIRS.filter((dir) => fs.existsSync(path.join(dataRoot, dir)));
  if (present.length === 0) return null;

  const target = path.join(backupsRoot, name);
  const partial = `${target}.partial`;
  await fs.promises.rm(partial, { recursive: true, force: true });
  await fs.promises.mkdir(partial, { recursive: true });
  for (const dir of present) {
    await fs.promises.cp(path.join(dataRoot, dir), path.join(partial, dir), {
      recursive: true,
      preserveTimestamps: true,
      mode: fs.constants.COPYFILE_FICLONE,
      filter: async (src) => {
        const stat = await fs.promises.lstat(src);
        return !stat.isSocket() && !stat.isFIFO();
      },
    });
  }
  // Only a complete copy gets the final name.
  await fs.promises.rm(target, { recursive: true, force: true });
  await fs.promises.rename(partial, target);

  for (const entry of await fs.promises.readdir(backupsRoot)) {
    if (entry !== name) {
      await fs.promises.rm(path.join(backupsRoot, entry), { recursive: true, force: true });
    }
  }
  return target;
}
