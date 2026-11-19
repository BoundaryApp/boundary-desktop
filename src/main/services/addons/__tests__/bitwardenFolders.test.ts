import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureBitwardenFolders } from '../bitwardenFolders';

let tmp: string;
let root: string;
let dataRoot: string;
let home: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-folders-'));
  root = path.join(tmp, 'stack');
  dataRoot = path.join(root, 'data');
  home = path.join(tmp, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mode = (p: string): number => fs.statSync(p).mode & 0o777;

function expectFolders(hostData: string): void {
  expect(fs.statSync(path.join(dataRoot, 'addons/bitwarden/instances')).isDirectory()).toBe(true);
  expect(mode(path.join(dataRoot, 'addons/bitwarden/instances'))).toBe(0o700);
  expect(mode(path.join(hostData, 'bw'))).toBe(0o700);
  expect(mode(path.join(hostData, 'broker'))).toBe(0o700);
  expect(mode(path.join(hostData, 'secrets'))).toBe(0o711);
}

describe('ensureBitwardenFolders', () => {
  it('creates the four folders under ./data/addons/bitwarden by default', async () => {
    await ensureBitwardenFolders({ root, dataRoot }, {});
    expectFolders(path.join(root, 'data/addons/bitwarden'));
  });

  it('expands a leading ~ in the .env value', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'BITWARDEN_HOST_DATA_DIR=~/bw-data\n');
    await ensureBitwardenFolders({ root, dataRoot }, { HOME: home });
    expectFolders(path.join(home, 'bw-data'));
  });

  it('resolves a relative value against the stack root', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'BITWARDEN_HOST_DATA_DIR=custom/bw\n');
    await ensureBitwardenFolders({ root, dataRoot }, {});
    expectFolders(path.join(root, 'custom/bw'));
  });

  it('prefers the environment over .env', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'BITWARDEN_HOST_DATA_DIR=from-env-file\n');
    const fromEnv = path.join(tmp, 'from-process-env');
    await ensureBitwardenFolders({ root, dataRoot }, { BITWARDEN_HOST_DATA_DIR: fromEnv });
    expectFolders(fromEnv);
    expect(fs.existsSync(path.join(root, 'from-env-file'))).toBe(false);
  });

  it('leaves an existing folder’s mode unchanged', async () => {
    const hostData = path.join(root, 'data/addons/bitwarden');
    fs.mkdirSync(path.join(hostData, 'secrets'), { recursive: true });
    fs.chmodSync(path.join(hostData, 'secrets'), 0o755);
    await ensureBitwardenFolders({ root, dataRoot }, {});
    expect(mode(path.join(hostData, 'secrets'))).toBe(0o755);
    expect(mode(path.join(hostData, 'bw'))).toBe(0o700);
  });

  it('throws when a path exists and is not a folder', async () => {
    const hostData = path.join(root, 'data/addons/bitwarden');
    fs.mkdirSync(hostData, { recursive: true });
    fs.writeFileSync(path.join(hostData, 'bw'), 'x');
    await expect(ensureBitwardenFolders({ root, dataRoot }, {})).rejects.toThrow(`${path.join(hostData, 'bw')} exists and is not a folder`);
  });
});
