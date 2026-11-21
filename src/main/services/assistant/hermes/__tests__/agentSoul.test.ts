import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localStackFiles } from '../../../stackHost/localStackHost';
import { excerptSoul, readSoulFile, resolveSoulFilePath, rewriteSoulIdentity } from '../agentSoul';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('agentSoul', () => {
  it('excerpts the first prose paragraph after the title', () => {
    const soul = [
      '# UI/UX Designer',
      '',
      'Prefers concise visual critique. Asks before rewriting a whole deck.',
      '',
      '## Memory',
      '- Private: your memories/',
    ].join('\n');
    expect(excerptSoul(soul)).toBe(
      'Prefers concise visual critique. Asks before rewriting a whole deck.'
    );
  });

  it('caps a long paragraph and resolves the host file', async () => {
    const long = `Lead ${'word '.repeat(80)}end`;
    const excerpt = excerptSoul(`# Name\n\n${long}`);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(281);

    const stackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-soul-'));
    temps.push(stackRoot);
    const root = path.join(stackRoot, 'data');
    const file = resolveSoulFilePath(root, 'designer');
    expect(file).toBe(path.join(root, 'hermes', 'profiles', 'designer', 'SOUL.md'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# Designer\n\nVoice lives here.\n');
    const files = localStackFiles({ stackRoot, userContentRoot: () => root });
    expect(await readSoulFile(files, 'designer')).toContain('Voice lives here');
    expect(await readSoulFile(files, 'nobody')).toBeNull();
  });

  it("finds the built-in agent's soul in the default profile's home", async () => {
    const stackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-soul-'));
    temps.push(stackRoot);
    const root = path.join(stackRoot, 'data');
    const file = resolveSoulFilePath(root, 'assistant');
    expect(file).toBe(path.join(root, 'hermes', 'SOUL.md'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# Hob\n\nKeeps the house.\n');
    const files = localStackFiles({ stackRoot, userContentRoot: () => root });
    expect(await readSoulFile(files, 'assistant')).toContain('Keeps the house');
  });
});

describe('rewriteSoulIdentity (ADR 0010 §4)', () => {
  const from = { displayName: 'Ana', role: 'Find vendors.' };
  const to = { displayName: 'Ana Pricing', role: 'Compare vendor pricing.' };

  it('swaps the title and the role and keeps everything else', () => {
    const soul = '# Ana\n\nFind vendors.\n\n## Memory\n- Private.\n\nMy own note.\n';
    expect(rewriteSoulIdentity(soul, from, to)).toBe(
      '# Ana Pricing\n\nCompare vendor pricing.\n\n## Memory\n- Private.\n\nMy own note.\n'
    );
  });

  it('rewrites a soul that ends with the role', () => {
    expect(rewriteSoulIdentity('# Ana\n\nFind vendors.', from, to)).toBe(
      '# Ana Pricing\n\nCompare vendor pricing.'
    );
  });

  it('leaves a soul alone once its title or role was edited by hand', () => {
    expect(rewriteSoulIdentity('# Ana the Great\n\nFind vendors.\n', from, to)).toBeNull();
    expect(rewriteSoulIdentity('# Ana\n\nFind vendors. Then haggle.\n', from, to)).toBeNull();
    expect(rewriteSoulIdentity('# Ana\n\nSomething else.\n', from, to)).toBeNull();
  });
});
