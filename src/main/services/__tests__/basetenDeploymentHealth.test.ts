import { describe, it, expect } from 'vitest';
import {
  isBasetenDeployReadyHealth,
  mapBasetenDeploymentToHealth,
} from '../infrastructure/basetenDeploymentHealth';

describe('basetenDeploymentHealth', () => {
  it('maps SCALED_TO_ZERO to idle deploy-ready', () => {
    const mapped = mapBasetenDeploymentToHealth({
      id: 'dep-1',
      status: 'SCALED_TO_ZERO',
      activeReplicaCount: 0,
      isProduction: true,
    });
    expect(mapped.status).toBe('idle');
    expect(mapped.deployReady).toBe(true);
  });

  it('maps ACTIVE with replicas to healthy', () => {
    const mapped = mapBasetenDeploymentToHealth({
      id: 'dep-1',
      status: 'ACTIVE',
      activeReplicaCount: 1,
      isProduction: true,
    });
    expect(mapped.status).toBe('healthy');
    expect(mapped.deployReady).toBe(true);
  });

  it('maps BUILDING to unknown not deploy-ready', () => {
    const mapped = mapBasetenDeploymentToHealth({
      id: 'dep-1',
      status: 'BUILDING',
      activeReplicaCount: 0,
      isProduction: true,
    });
    expect(mapped.status).toBe('unknown');
    expect(mapped.deployReady).toBe(false);
  });

  it('maps INACTIVE to blocked billing state', () => {
    const mapped = mapBasetenDeploymentToHealth({
      id: 'dep-1',
      status: 'INACTIVE',
      activeReplicaCount: 0,
      isProduction: true,
    });
    expect(mapped.status).toBe('blocked');
    expect(mapped.deployReady).toBe(false);
    expect(mapped.message).toContain('payment method');
  });

  it('isBasetenDeployReadyHealth accepts healthy and idle', () => {
    expect(isBasetenDeployReadyHealth('healthy')).toBe(true);
    expect(isBasetenDeployReadyHealth('idle')).toBe(true);
    expect(isBasetenDeployReadyHealth('unhealthy')).toBe(false);
    expect(isBasetenDeployReadyHealth('blocked')).toBe(false);
  });
});
