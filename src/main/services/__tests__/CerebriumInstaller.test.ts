import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/boundary-test-userdata',
  },
}));

import {
  getManagedCerebriumBinDir,
  getManagedCerebriumExecutable,
  getManagedCerebriumVenvDir,
} from '../infrastructure/CerebriumInstaller';

describe('CerebriumInstaller', () => {
  it('places managed Cerebrium CLI under userData tools', () => {
    expect(getManagedCerebriumVenvDir()).toContain('tools/cerebrium/venv');
    expect(getManagedCerebriumBinDir()).toContain('tools/cerebrium/bin');
    expect(getManagedCerebriumExecutable()).toContain('tools/cerebrium/bin');
  });
});
