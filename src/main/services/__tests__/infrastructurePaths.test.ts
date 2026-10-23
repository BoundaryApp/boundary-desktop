import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  hasInfrastructureTree,
  resolveInfrastructureRoot,
} from '../infrastructure/infrastructurePaths';

const tmpDirs: string[] = [];

function makeTree(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `boundary-infra-${label}-`));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, 'infrastructure', 'catalog'), { recursive: true });
  fs.writeFileSync(path.join(root, 'infrastructure', 'catalog', 'models.json'), '{"models":[]}');
  return root;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveInfrastructureRoot', () => {
  it('uses packaged resourcesPath when cwd is filesystem root', () => {
    const resources = makeTree('resources');
    const root = resolveInfrastructureRoot({
      cwd: '/',
      resourcesPath: resources,
      appPath: path.join(resources, 'app.asar'),
    });
    expect(root).toBe(path.resolve(resources));
    expect(hasInfrastructureTree(root)).toBe(true);
  });

  it('falls back to / when nothing is bundled (packaged DMG bug)', () => {
    const asar = path.join('/Applications', 'Boundary.app', 'Contents', 'Resources', 'app.asar');
    const root = resolveInfrastructureRoot({
      cwd: '/',
      resourcesPath: path.dirname(asar),
      appPath: asar,
    });
    expect(root).toBe(path.resolve('/'));
    expect(hasInfrastructureTree(root)).toBe(false);
    expect(path.join(root, 'infrastructure', 'catalog', 'models.json')).toBe(
      '/infrastructure/catalog/models.json'
    );
  });

  it('prefers BOUNDARY_REPO_ROOT over cwd', () => {
    const envRoot = makeTree('env');
    const cwdRoot = makeTree('cwd');
    const root = resolveInfrastructureRoot({
      envRoot,
      cwd: cwdRoot,
    });
    expect(root).toBe(path.resolve(envRoot));
  });

  it('uses repo cwd in development', () => {
    const cwdRoot = makeTree('dev');
    const root = resolveInfrastructureRoot({
      cwd: cwdRoot,
      resourcesPath: '/nonexistent-resources',
    });
    expect(root).toBe(path.resolve(cwdRoot));
  });
});
