import { describe, expect, it } from 'vitest';
import { STACK_CAPABILITY_MISSING_TEXT } from '../../../../shared/stackCapabilities';
import {
  StackCapabilityMissing,
  getStackCapabilities,
  hasStackCapability,
  requireStackCapability,
  stackCapabilityRefusal,
} from '../capabilities';
import { createFakeStackHost, fakeCapabilitiesModule } from '../fakeStackHost';

describe('stack host capabilities', () => {
  it('are all present on the local host, the only one there is', () => {
    expect(getStackCapabilities()).toEqual({ hostFolders: true, hostCallbacks: true, provision: true, engineControl: true });
    expect(hasStackCapability('provision')).toBe(true);
    expect(stackCapabilityRefusal('hostFolders')).toBeNull();
    expect(() => requireStackCapability('engineControl')).not.toThrow();
  });

  it('a missing one refuses with the text the feature shows', () => {
    const host = createFakeStackHost({ capabilities: { hostCallbacks: false } });
    const fake = fakeCapabilitiesModule(() => host.capabilities);
    expect(fake.hasStackCapability('hostCallbacks')).toBe(false);
    expect(fake.hasStackCapability('hostFolders')).toBe(true);
    expect(fake.stackCapabilityRefusal('hostCallbacks')).toBe(STACK_CAPABILITY_MISSING_TEXT.hostCallbacks);
    let thrown: unknown;
    try {
      fake.requireStackCapability('hostCallbacks');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StackCapabilityMissing);
    expect((thrown as StackCapabilityMissing).capability).toBe('hostCallbacks');
    expect((thrown as Error).message).toBe(STACK_CAPABILITY_MISSING_TEXT.hostCallbacks);
  });
});

describe('createFakeStackHost', () => {
  it('records commands, keeps files in memory and builds endpoint URLs', async () => {
    const host = createFakeStackHost({ files: { 'stack:.env': 'A=1\n' }, ports: { apiServer: 8642 } });
    await host.commands.compose(['ps']);
    await host.commands.runScript('scripts/addon.sh', ['list'], {} as never);
    expect(host.calls).toEqual([
      { method: 'compose', args: ['ps'] },
      { method: 'runScript', args: ['scripts/addon.sh', 'list'] },
    ]);
    await expect(host.files.readText('stack', '.env')).resolves.toBe('A=1\n');
    expect(host.endpoints.url('apiServer', '/health')).toBe('http://127.0.0.1:8642/health');
    expect(host.kind).toBe('fake');
  });
});
