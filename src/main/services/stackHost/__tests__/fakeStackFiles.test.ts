import { describe, expect, it } from 'vitest';
import { createFakeStackFiles } from '../fakeStackFiles';

describe('fake stack files', () => {
  it('reads, writes, lists and removes like the local host', async () => {
    const files = createFakeStackFiles({ 'data:hermes/.env': 'A=1\n' });
    await expect(files.readText('data', 'hermes/.env')).resolves.toBe('A=1\n');
    await expect(files.readText('stack', '.env')).resolves.toBeNull();
    await files.writeText('data', 'hermes/profiles/b/.env', 'B=1\n', { mode: 0o600 });
    await files.mkdir('data', 'hermes/profiles/a');
    await expect(files.list('data', 'hermes/profiles')).resolves.toEqual(['a', 'b']);
    await expect(files.exists('data', 'hermes/profiles/b')).resolves.toBe(true);
    expect(files.modes.get('data:hermes/profiles/b/.env')).toBe(0o600);
    await files.remove('data', 'hermes/profiles');
    await expect(files.list('data', 'hermes/profiles')).resolves.toBeNull();
    await expect(files.list('data', 'hermes')).resolves.toEqual(['.env']);
  });

  it('stats, renames, resolves and writes bytes like the local host', async () => {
    const files = createFakeStackFiles({ 'userContent:voice/.a.creating/samples/x.md': 'hello' });
    await expect(files.stat('userContent', 'voice/.a.creating/samples/x.md')).resolves.toEqual({
      kind: 'file',
      size: 5,
    });
    await expect(files.stat('userContent', 'voice')).resolves.toEqual({ kind: 'folder', size: 0 });
    await expect(files.stat('userContent', 'missing')).resolves.toBeNull();
    await files.rename('userContent', 'voice/.a.creating', 'voice/a');
    await expect(files.list('userContent', 'voice')).resolves.toEqual(['a']);
    await expect(files.realpath('userContent', 'voice/a/samples/x.md')).resolves.toBe('voice/a/samples/x.md');
    await expect(files.realpath('userContent', 'voice/a/none.md')).resolves.toBeNull();
    await files.writeBytes('userContent', 'voice/a/samples/y.md', new TextEncoder().encode('é'), { mode: 0o600 });
    await expect(files.readText('userContent', 'voice/a/samples/y.md')).resolves.toBe('é');
    await expect(files.stat('userContent', 'voice/a/samples/y.md')).resolves.toEqual({ kind: 'file', size: 2 });
    expect(files.modes.get('userContent:voice/a/samples/y.md')).toBe(0o600);
    await files.mkdir('userContent', 'addons/twenty', { mode: 0o700 });
    expect(files.modes.get('userContent:addons/twenty')).toBe(0o700);
  });

  it('refuses paths that leave their location', async () => {
    const files = createFakeStackFiles();
    await expect(files.readText('stack', '../x')).rejects.toThrow(/outside/);
    await expect(files.readText('stack', '/etc/x')).rejects.toThrow(/relative/);
    await expect(files.remove('stack', '.')).rejects.toThrow(/Refusing/);
  });
});
