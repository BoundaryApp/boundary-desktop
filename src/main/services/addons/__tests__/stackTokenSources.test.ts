import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureStackTokenSources, type StackTokenSourceDeps, type TokenScript, type TokenSource } from '../stackTokenSources';

// The fake scripts do what they do at stack v0.3.16 (1e50da5):
// - scripts/web-browser-secrets.sh writes `agent`, `credentials` and `viewer` under
//   ${ASSISTANT_DATA_ROOT}/web-browser/secrets when missing or empty, skips one that is a folder
//   with a warning, and exits 0 even when it writes nothing;
// - vault.sh api-token writes broker-api/api-token under BITWARDEN_HOST_DATA_DIR, and exits
//   non-zero (die) when it can't.

let dir: string;
let dataRoot: string;
let hostData: string;
let runs: { script: TokenScript; args: string[] }[];
let writes: boolean;

const browserToken = (name: string) => path.join(dataRoot, 'web-browser', 'secrets', name);
const brokerToken = () => path.join(hostData, 'broker-api', 'api-token');

function writeToken(file: string): void {
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) return;
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, 'a'.repeat(64) + '\n', { mode: 0o600 });
}

function source(file: string): TokenSource {
  if (!fs.existsSync(file)) return { path: file, state: 'missing' };
  if (fs.statSync(file).isDirectory()) return { path: file, state: 'folder' };
  return { path: file, state: fs.statSync(file).size > 0 ? 'file' : 'missing' };
}

function deps(over: Partial<StackTokenSourceDeps> = {}): StackTokenSourceDeps {
  return {
    hasTokenScripts: async () => true,
    browserTokens: async () => [source(browserToken('agent')), source(browserToken('credentials'))],
    brokerToken: async () => source(brokerToken()),
    run: async (script, args) => {
      runs.push({ script, args });
      if (script === 'web-browser-secrets.sh') {
        if (writes) for (const name of ['agent', 'credentials', 'viewer']) writeToken(browserToken(name));
        return { code: 0, stdout: '', stderrTail: [] };
      }
      if (!writes) return { code: 1, stdout: '', stderrTail: ['could not write'] };
      writeToken(brokerToken());
      return { code: 0, stdout: '', stderrTail: [] };
    },
    log: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-sources-'));
  dataRoot = path.join(dir, 'data');
  hostData = path.join(dir, 'data', 'addons', 'bitwarden');
  runs = [];
  writes = true;
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('ensureStackTokenSources', () => {
  it('does nothing on a stack tree older than v0.3.16', async () => {
    await ensureStackTokenSources(deps({ hasTokenScripts: async () => false }));
    expect(runs).toEqual([]);
    expect(fs.existsSync(dataRoot)).toBe(false);
  });

  it('runs both scripts when the tokens are missing, and leaves every mounted source a file', async () => {
    await ensureStackTokenSources(deps());
    expect(runs).toEqual([
      { script: 'web-browser-secrets.sh', args: [] },
      { script: 'vault.sh', args: ['api-token'] },
    ]);
    for (const file of [browserToken('agent'), browserToken('credentials'), brokerToken()]) {
      expect(fs.statSync(file).isFile()).toBe(true);
    }
  });

  it('runs nothing when every token is there', async () => {
    await ensureStackTokenSources(deps());
    runs = [];
    await ensureStackTokenSources(deps());
    expect(runs).toEqual([]);
  });

  it('runs only the script whose token is missing, and treats an empty file as missing', async () => {
    await ensureStackTokenSources(deps());
    runs = [];
    fs.writeFileSync(brokerToken(), '');
    await ensureStackTokenSources(deps());
    expect(runs).toEqual([{ script: 'vault.sh', args: ['api-token'] }]);
  });

  it('fails the start when web-browser-secrets.sh exits 0 without writing', async () => {
    writes = false;
    await expect(ensureStackTokenSources(deps())).rejects.toThrow(
      `${browserToken('agent')} couldn’t be created (scripts/web-browser-secrets.sh exited 0)`
    );
  });

  it('fails the start with vault.sh api-token’s exit code', async () => {
    await ensureStackTokenSources(deps());
    fs.rmSync(brokerToken());
    writes = false;
    await expect(ensureStackTokenSources(deps())).rejects.toThrow('(scripts/vault.sh exited 1)');
  });

  it('names a folder left at a token path, as Docker leaves one, without running the script', async () => {
    fs.mkdirSync(browserToken('agent'), { recursive: true });
    await expect(ensureStackTokenSources(deps())).rejects.toThrow(`${browserToken('agent')} is a folder`);
    expect(runs).toEqual([]);
  });
});
