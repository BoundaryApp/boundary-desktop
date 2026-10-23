import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/boundary-test-userdata',
  },
}));

import {
  canInstallTrussAutomatically,
  findPythonExecutable,
  getManagedTrussExecutable,
} from '../infrastructure/TrussInstaller';

describe('TrussInstaller', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('canInstallTrussAutomatically is true on supported platforms', async () => {
    const ok = await canInstallTrussAutomatically();
    expect(ok).toBe(true);
  });

  it('findPythonExecutable respects BOUNDARY_PYTHON', async () => {
    process.env.BOUNDARY_PYTHON = '/custom/python3';
    expect(await findPythonExecutable()).toBe('/custom/python3');
    delete process.env.BOUNDARY_PYTHON;
  });

  it('getManagedTrussExecutable lives under userData tools', () => {
    expect(getManagedTrussExecutable()).toContain('tools/truss/bin');
  });

});
