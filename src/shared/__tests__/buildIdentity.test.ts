import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(instance?: string, appName?: string) {
  vi.resetModules();
  if (instance) vi.stubGlobal('__BOUNDARY_INSTANCE__', instance);
  if (appName) vi.stubGlobal('__BOUNDARY_APP_NAME__', appName);
  return {
    identity: await import('../buildIdentity'),
    constants: await import('../assistantStackConstants'),
    lifecycle: await import('../assistantStackLifecycle'),
  };
}

describe('build identity', () => {
  it('names an instance so it can be a URL scheme', async () => {
    const { identity } = await load('boundary-beta');
    expect(identity.INSTANCE_NAME).toMatch(/^[a-z][a-z0-9+.-]*$/);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the existing names in a default build', async () => {
    const { identity, constants } = await load();
    expect(identity.APP_NAME).toBe('Boundary');
    expect(identity.IS_SEPARATE_INSTANCE).toBe(false);
    expect(constants.BOUNDARY_ASSISTANT_PROJECT_NAME).toBe('boundary-assistant');
    expect(constants.BOUNDARY_ASSISTANT_CONTAINER_PREFIX).toBe('boundary-');
    expect(constants.BOUNDARY_ASSISTANT_IMAGE_PREFIX).toBe('boundary-assistant');
    expect(constants.runtimeContainerName('boundary-hermes')).toBe('boundary-hermes');
  });

  it('gives a separate instance its own stack names', async () => {
    const { identity, constants } = await load('boundary-beta', 'Boundary Beta');
    expect(identity.APP_NAME).toBe('Boundary Beta');
    expect(identity.IS_SEPARATE_INSTANCE).toBe(true);
    expect(constants.BOUNDARY_ASSISTANT_PROJECT_NAME).toBe('boundary-beta-assistant');
    expect(constants.BOUNDARY_ASSISTANT_CONTAINER_PREFIX).toBe('boundary-beta-');
    expect(constants.BOUNDARY_ASSISTANT_IMAGE_PREFIX).toBe('boundary-beta-assistant');
  });

  it('maps a separate instance’s runtime names onto the shared container ids', async () => {
    const { constants, lifecycle } = await load('boundary-beta');
    expect(constants.runtimeContainerName('boundary-hermes')).toBe('boundary-beta-hermes');
    expect(constants.containerIdFromRuntimeName('boundary-beta-hermes')).toBe('boundary-hermes');
    expect(lifecycle.resolveContainerFromProgressId('Container boundary-beta-hermes-webui')).toBe(
      'boundary-hermes-webui'
    );
  });
});
