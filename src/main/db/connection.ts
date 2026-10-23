import { persistDebugLog, serializeError, fileStatForLog } from '../persistDebugLog';
import { BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import { createFileLogger } from '../../shared/utils/logger';

const log = createFileLogger(import.meta.url, 'boundary:main:db:connection');

/** Baseline schema for fresh packaged installs (drizzle-kit is unavailable at runtime). */
const CREATE_TASKS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL,
  progress real DEFAULT 0 NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  started_at integer,
  completed_at integer,
  canceled_at integer,
  error text,
  metadata text,
  file_path text,
  current_stage text,
  parent_task_id text,
  child_task_ids text,
  task_type text DEFAULT 'generic' NOT NULL,
  app_id text,
  app_name text,
  app_version text,
  deletion_method text,
  download_url text,
  author text,
  category text,
  current_version text,
  target_version text,
  update_url text,
  source_path text,
  destination_path text,
  backup_type text,
  compression_level integer,
  sync_mode text,
  conflict_resolution text,
  project_path text,
  build_target text,
  build_configuration text,
  build_tools text,
  deployment_target text,
  deployment_method text,
  environment text,
  rollback_enabled integer,
  providers text,
  email text,
  first_name text,
  last_name text,
  company text,
  phone text
);
`;

// Run drizzle-kit under Electron-as-Node so better-sqlite3 matches Electron's ABI
// (system Node from nvm/Homebrew is often ABI 137/141 while electron-rebuild builds for 133).
async function runDrizzleKit(command: string[], configPath: string, cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const drizzleKitEntry = path.join(process.cwd(), 'node_modules', 'drizzle-kit', 'bin.cjs');

    const child = spawn(
      process.execPath,
      [drizzleKitEntry, ...command, '--config', configPath],
      {
        stdio: 'inherit',
        cwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }
    );

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`drizzle-kit ${command[0]} exited with code ${code}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

export let db: BetterSQLite3Database;
export let dbPath: string;
export let dbDir: string;

function ensureDbPaths(): void {
  const userDataPath = app.getPath('userData');
  dbDir = path.join(userDataPath, 'db');
  dbPath = path.join(dbDir, 'boundary.db');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

/**
 * Packaged installs (and CREATE TABLE IF NOT EXISTS) can create `tasks` without
 * recording drizzle journal hashes. Dev `drizzle-kit migrate` then re-runs
 * CREATE TABLE and fails. Mark existing journal entries as applied when the
 * schema is already present but the ledger is empty.
 */
async function baselineDrizzleMigrationsIfNeeded(): Promise<{
  baselined: boolean;
  reason: string;
  seededCount?: number;
}> {
  ensureDbPaths();
  if (!fs.existsSync(dbPath)) {
    return { baselined: false, reason: 'no_db' };
  }

  const journalPath = path.join(dbDir, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) {
    return { baselined: false, reason: 'no_journal' };
  }

  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    entries?: Array<{ tag: string; when: number }>;
  };
  const entries = journal.entries ?? [];
  if (entries.length === 0) {
    return { baselined: false, reason: 'empty_journal' };
  }

  const { default: Database } = await import('better-sqlite3');
  const sqlite = new Database(dbPath);
  try {
    const tables = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);

    if (!tables.includes('tasks')) {
      return { baselined: false, reason: 'no_tasks_table' };
    }

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash text NOT NULL,
        created_at numeric
      )
    `);

    const migrationRowCount = (
      sqlite.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get() as { c: number }
    ).c;
    if (migrationRowCount > 0) {
      return { baselined: false, reason: 'already_tracked', seededCount: migrationRowCount };
    }

    const insert = sqlite.prepare(
      'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)'
    );
    const seed = sqlite.transaction((journalEntries: Array<{ tag: string; when: number }>) => {
      for (const entry of journalEntries) {
        const sqlPath = path.join(dbDir, `${entry.tag}.sql`);
        if (!fs.existsSync(sqlPath)) {
          throw new Error(`Missing migration SQL for journal tag ${entry.tag}`);
        }
        const query = fs.readFileSync(sqlPath, 'utf8');
        const hash = crypto.createHash('sha256').update(query).digest('hex');
        insert.run(hash, entry.when);
      }
    });
    seed(entries);

    log(
      `Baselined ${entries.length} drizzle migration(s); schema already present without journal rows`
    );
    return { baselined: true, reason: 'seeded_empty_ledger', seededCount: entries.length };
  } finally {
    sqlite.close();
  }
}

// Dynamically generate Drizzle config when app is ready (dev / unpackaged only)
function generateDrizzleConfig() {
  ensureDbPaths();

  // Create a temporary config file for drizzle-kit
  const tempConfigPath = path.join(dbDir, 'drizzle.config.temp.js');
  const projectRoot = process.cwd();
  const schemaPath = path.join(projectRoot, 'src', 'main', 'db', 'schema');

  const drizzleKitPath = path.join(projectRoot, 'node_modules', 'drizzle-kit');
  const configContent = `
const { defineConfig } = require('${drizzleKitPath}');

module.exports = defineConfig({
  out: '.',
  schema: '${schemaPath}',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'file:${dbPath}',
  },
});
`;

  fs.writeFileSync(tempConfigPath, configContent);
  return tempConfigPath;
}

async function openDatabaseConnection(): Promise<void> {
  persistDebugLog('db', 'about to import better-sqlite3', {
    dbPath,
    isPackaged: app.isPackaged,
    dbPathStat: fileStatForLog(dbPath),
  });
  const { default: Database } = await import('better-sqlite3');
  persistDebugLog('db', 'better-sqlite3 import succeeded', {
    hasDatabase: typeof Database === 'function',
  });
  const sqlite = new Database(dbPath);
  sqlite.exec(CREATE_TASKS_TABLE_SQL);
  db = drizzle(sqlite);
  log('Database connection established successfully');

  // Check if current_stage column exists, if not add it
  try {
    await db.run('SELECT current_stage FROM tasks LIMIT 1');
    log('current_stage column already exists');
  } catch (error) {
    log('Adding current_stage column to tasks table...');
    await db.run('ALTER TABLE tasks ADD COLUMN current_stage TEXT');
    log('current_stage column added successfully');
  }

  // Check if parent_task_id column exists, if not add it
  try {
    await db.run('SELECT parent_task_id FROM tasks LIMIT 1');
    log('parent_task_id column already exists');
  } catch (error) {
    log('Adding parent_task_id column to tasks table...');
    await db.run('ALTER TABLE tasks ADD COLUMN parent_task_id TEXT');
    log('parent_task_id column added successfully');
  }

  // Check if child_task_ids column exists, if not add it
  try {
    await db.run('SELECT child_task_ids FROM tasks LIMIT 1');
    log('child_task_ids column already exists');
  } catch (error) {
    log('Adding child_task_ids column to tasks table...');
    await db.run('ALTER TABLE tasks ADD COLUMN child_task_ids TEXT');
    log('child_task_ids column added successfully');
  }

  // Check if task_type column exists, if not add it
  try {
    await db.run('SELECT task_type FROM tasks LIMIT 1');
    log('task_type column already exists');
  } catch (error) {
    log('Adding task_type column to tasks table...');
    await db.run('ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT "generic"');
    log('task_type column added successfully');
  }

  // Add type-specific columns if they don't exist
  const typeSpecificColumns = [
    'app_id',
    'app_name',
    'app_version',
    'deletion_method',
    'download_url',
    'author',
    'category',
    'current_version',
    'target_version',
    'update_url',
    'source_path',
    'destination_path',
    'backup_type',
    'compression_level',
    'sync_mode',
    'conflict_resolution',
    'project_path',
    'build_target',
    'build_configuration',
    'build_tools',
    'deployment_target',
    'deployment_method',
    'environment',
    'rollback_enabled',
    // Account creation columns
    'providers',
    'email',
    'first_name',
    'last_name',
    'company',
    'phone',
  ];

  for (const column of typeSpecificColumns) {
    try {
      await db.run(`SELECT ${column} FROM tasks LIMIT 1`);
      log(`${column} column already exists`);
    } catch (error) {
      log(`Adding ${column} column to tasks table...`);
      const columnType =
        column === 'compression_level' || column === 'rollback_enabled' ? 'INTEGER' : 'TEXT';
      await db.run(`ALTER TABLE tasks ADD COLUMN ${column} ${columnType}`);
      log(`${column} column added successfully`);
    }
  }
}

export async function initializeDatabase() {
  log('Initializing database...');
  ensureDbPaths();
  persistDebugLog('db', 'initializeDatabase start', {
    isPackaged: app.isPackaged,
    dbPath,
    dbDir,
    dbDirExists: fs.existsSync(dbDir),
    dbFileExists: fs.existsSync(dbPath),
  });

  if (app.isPackaged) {
    // Packaged apps cannot spawn project-local drizzle-kit (process.cwd() is not the project).
    try {
      await openDatabaseConnection();
      persistDebugLog('db', 'packaged DB open succeeded', { dbPath });
      return;
    } catch (error) {
      persistDebugLog('db', 'packaged DB open failed', serializeError(error));
      console.error('Failed to create database connection:', error);
      throw error;
    }
  }

  // Development: use drizzle-kit generate/migrate against the project tree
  const tempConfigPath = generateDrizzleConfig();

  // Copy meta directory from development to userData if it doesn't exist
  const devMetaDir = path.join(process.cwd(), 'src', 'main', 'db', 'db', 'meta');
  const userDataMetaDir = path.join(dbDir, 'meta');

  if (fs.existsSync(devMetaDir) && !fs.existsSync(userDataMetaDir)) {
    log('Copying meta directory to userData...');
    try {
      fs.cpSync(devMetaDir, userDataMetaDir, { recursive: true });
      log('Successfully copied meta directory');
    } catch (error) {
      console.error('Error copying meta directory:', error);
      // Continue anyway - drizzle-kit might be able to generate it
    }
  }

  let migrationsSuccessful = false;

  // Generate migrations to check for schema changes
  log('Checking for schema changes...');
  try {
    await runDrizzleKit(['generate'], tempConfigPath, dbDir);
    log('Successfully generated migrations');
    migrationsSuccessful = true;
  } catch (error) {
    console.error('Error generating migrations:', error);
    // Clean up temp config
    fs.unlinkSync(tempConfigPath);
    throw error;
  }

  // Run `drizzle-kit migrate` if we have migrations or if database exists
  if (migrationsSuccessful || fs.existsSync(dbPath)) {
    try {
      await baselineDrizzleMigrationsIfNeeded();
    } catch (baselineError) {
      console.error('Error baselining drizzle migrations:', baselineError);
      fs.unlinkSync(tempConfigPath);
      throw baselineError;
    }

    log('Running migrations...');
    try {
      await runDrizzleKit(['migrate'], tempConfigPath, dbDir);
      log('Successfully ran migrations');
    } catch (error) {
      console.error('Error running migrations:', error);
      // Clean up temp config
      fs.unlinkSync(tempConfigPath);
      throw error;
    }
  }

  // Clean up temp config
  try {
    fs.unlinkSync(tempConfigPath);
  } catch (error) {
    console.warn('Could not clean up temp config file:', error);
  }

  try {
    await openDatabaseConnection();
  } catch (error) {
    console.error('Failed to create database connection:', error);
    throw error;
  }
}
