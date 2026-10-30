import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupStackDataBeforeUpgrade } from '../stackDataBackup';

describe('backupStackDataBeforeUpgrade', () => {
  let dir: string;
  let dataRoot: string;
  let backupsRoot: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-backup-'));
    dataRoot = path.join(dir, 'data');
    backupsRoot = path.join(dir, 'backups');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, contents: string): void {
    const file = path.join(dataRoot, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }

  it('copies the migrating data dirs and nothing else', async () => {
    write('n8n/database.sqlite', 'n8n');
    write('hermes/state.db', 'hermes');
    write('neo4j/data/graph', 'neo4j');
    write('db/18/docker/PG_VERSION', '18');
    write('gptr/outputs/report.md', 'report');

    const target = await backupStackDataBeforeUpgrade({ dataRoot, backupsRoot, name: 'data-at-old' });

    expect(target).toBe(path.join(backupsRoot, 'data-at-old'));
    expect(fs.readFileSync(path.join(target!, 'n8n', 'database.sqlite'), 'utf8')).toBe('n8n');
    expect(fs.readFileSync(path.join(target!, 'hermes', 'state.db'), 'utf8')).toBe('hermes');
    expect(fs.readFileSync(path.join(target!, 'neo4j', 'data', 'graph'), 'utf8')).toBe('neo4j');
    expect(fs.existsSync(path.join(target!, 'db', '18', 'docker', 'PG_VERSION'))).toBe(true);
    expect(fs.existsSync(path.join(target!, 'gptr'))).toBe(false);
    expect(fs.existsSync(path.join(target!, 'rag_storage'))).toBe(false);
  });

  it('keeps only the newest backup', async () => {
    write('n8n/database.sqlite', 'v1');
    await backupStackDataBeforeUpgrade({ dataRoot, backupsRoot, name: 'data-at-one' });
    write('n8n/database.sqlite', 'v2');
    await backupStackDataBeforeUpgrade({ dataRoot, backupsRoot, name: 'data-at-two' });

    expect(fs.readdirSync(backupsRoot)).toEqual(['data-at-two']);
    expect(
      fs.readFileSync(path.join(backupsRoot, 'data-at-two', 'n8n', 'database.sqlite'), 'utf8')
    ).toBe('v2');
  });

  it('skips sockets left in the data', async () => {
    write('hermes/state.db', 'hermes');
    // Unix socket paths are short; listen relative to the data dir.
    const cwd = process.cwd();
    process.chdir(path.join(dataRoot, 'hermes'));
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen('ctl.sock', resolve));
    process.chdir(cwd);
    try {
      const target = await backupStackDataBeforeUpgrade({ dataRoot, backupsRoot, name: 'data-at-x' });
      expect(fs.existsSync(path.join(target!, 'hermes', 'state.db'))).toBe(true);
      expect(fs.existsSync(path.join(target!, 'hermes', 'ctl.sock'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns null when there is no data yet', async () => {
    expect(await backupStackDataBeforeUpgrade({ dataRoot, backupsRoot, name: 'x' })).toBeNull();
    expect(fs.existsSync(backupsRoot)).toBe(false);
  });
});
