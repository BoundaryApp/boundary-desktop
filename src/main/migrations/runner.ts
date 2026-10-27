import Store from 'electron-store';
import { persistDebugLog, serializeError } from '../persistDebugLog';

/**
 * A one-time change to data an earlier version stored. It runs at most once per install,
 * at startup, before the services that read that data.
 */
export interface Migration {
  /** Key in the record of what ran. Never reuse one, or installs that ran it skip the new one. */
  id: string;
  /** The release after which this migration, and code only it uses, can be deleted. */
  removeAfter: string;
  /**
   * Returns false when it can't finish yet, and it runs again at the next start. A throw is
   * logged, and it also runs again at the next start.
   */
  run: () => boolean | void;
}

/** Which migrations finished, by id. */
export interface MigrationRecord {
  has(id: string): boolean;
  add(id: string): void;
}

interface MigrationsStoreShape {
  /** Migration id → when it finished. */
  ran: Record<string, string>;
}

function storedRecord(): MigrationRecord {
  const store = new Store<MigrationsStoreShape>({ name: 'migrations', defaults: { ran: {} } });
  return {
    has: (id) => Boolean(store.get('ran')?.[id]),
    add: (id) => store.set('ran', { ...(store.get('ran') ?? {}), [id]: new Date().toISOString() }),
  };
}

/**
 * Run each migration that hasn't finished, in order. A failure is logged and doesn't stop
 * startup or the migrations after it.
 */
export function runMigrations(
  migrations: readonly Migration[],
  record: MigrationRecord = storedRecord()
): void {
  for (const migration of migrations) {
    if (record.has(migration.id)) continue;
    try {
      if (migration.run() === false) continue;
      record.add(migration.id);
      persistDebugLog('migrations', 'ran', { id: migration.id });
    } catch (error) {
      console.warn(`[migrations] ${migration.id} failed`, error);
      persistDebugLog('migrations', 'failed', { id: migration.id, error: serializeError(error) });
    }
  }
}
