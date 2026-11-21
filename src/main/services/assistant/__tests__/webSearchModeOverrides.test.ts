import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localStackFiles } from '../../stackHost/localStackHost';
import { findWebSearchModeOverrides } from '../webSearchModeOverrides';

const dirs: string[] = [];

function stackFiles(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsm-'));
  dirs.push(root);
  const home = path.join(root, 'data', 'hermes');
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return localStackFiles({ stackRoot: root, userContentRoot: () => path.join(root, 'data') });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('findWebSearchModeOverrides', () => {
  it('lists the home and profile .env files that set the key, commented lines excluded', async () => {
    const files = stackFiles({
      '.env': 'OTHER=1\nexport HERMES_WEB_SEARCH_MODE=keyless\n',
      'profiles/browser/.env': '# HERMES_WEB_SEARCH_MODE=keyless\n',
      'profiles/api-server/.env': 'HERMES_WEB_SEARCH_MODE=\n',
      'profiles/empty/notes.txt': 'x',
    });
    expect(await findWebSearchModeOverrides(files)).toEqual(['.env', 'profiles/api-server/.env']);
  });

  it('is empty when the home is missing', async () => {
    expect(await findWebSearchModeOverrides(stackFiles({}))).toEqual([]);
  });
});
