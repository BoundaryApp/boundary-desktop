import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveForeignProjectsAt } from '../liveLocalStack';

describe('liveForeignProjectsAt', () => {
  const root = '/work/assistant';

  it('finds the checkout’s own project and skips Boundary’s', () => {
    const ps = [
      `assistant\t${root}`,
      `assistant\t${root}`,
      `boundary-assistant\t${root}`,
      'lead-gen\t/work/lead-gen',
      '\t',
      '',
    ].join('\n');
    expect(liveForeignProjectsAt(root, ps)).toEqual(['assistant']);
  });

  it('returns nothing when only Boundary’s project runs from the checkout', () => {
    expect(liveForeignProjectsAt(root, `boundary-assistant\t${root}\n`)).toEqual([]);
  });

  it('matches the checkout through a symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-stack-'));
    const real = path.join(dir, 'assistant');
    const link = path.join(dir, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    try {
      expect(liveForeignProjectsAt(link, `assistant\t${fs.realpathSync(real)}\n`)).toEqual([
        'assistant',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
