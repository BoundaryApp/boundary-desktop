import { describe, expect, it, vi } from 'vitest';
import { V0316_COMPOSE } from '../../assistant/__tests__/engineOverlayFixture';
import { removeStaleSignerVolume, SIGNER_VOLUME_NAME, volumeMountOption, type SignerVolumeDeps } from '../signerVolume';
import type { RuntimeKind } from '../../containerRuntime/types';

const OVERLAY_O = 'mode=1777,size=1m,context=system_u:object_r:container_file_t:s0';

/** `{{json .Options}}` as Podman prints it for a local tmpfs volume. */
const options = (o: string) => JSON.stringify({ device: 'tmpfs', o, type: 'tmpfs' });

function deps(over: { kind?: RuntimeKind; compose?: string; inspect?: () => Promise<string>; rm?: () => Promise<string> } = {}) {
  const cli = vi.fn(async (args: string[]) => {
    if (args[1] === 'inspect') return (over.inspect ?? (async () => options(OVERLAY_O)))();
    if (args[1] === 'rm') return (over.rm ?? (async () => `${SIGNER_VOLUME_NAME}\n`))();
    throw new Error(`unexpected ${args.join(' ')}`);
  });
  const log = vi.fn();
  const value: SignerVolumeDeps = {
    runtimeKind: async () => over.kind ?? 'podman',
    composeText: async () => over.compose ?? V0316_COMPOSE,
    cli,
    log,
  };
  return { value, cli, log };
}

describe('volumeMountOption', () => {
  it('reads o, and null when it is missing or the text is not JSON', () => {
    expect(volumeMountOption(options('mode=1777'))).toBe('mode=1777');
    expect(volumeMountOption('{"type":"tmpfs"}')).toBeNull();
    expect(volumeMountOption('null')).toBeNull();
    expect(volumeMountOption('no such volume')).toBeNull();
  });
});

describe('removeStaleSignerVolume', () => {
  it('removes a volume made with the stack’s own options, which Podman keeps in o', async () => {
    const d = deps({ inspect: async () => options('uid=501,gid=20,mode=0700,size=1m') });
    expect(await removeStaleSignerVolume(d.value)).toBe('removed');
    expect(d.cli).toHaveBeenCalledWith(['volume', 'inspect', 'boundary-assistant_bitwarden_signin', '--format', '{{json .Options}}']);
    expect(d.cli).toHaveBeenCalledWith(['volume', 'rm', '--force', 'boundary-assistant_bitwarden_signin']);
    expect(d.log).toHaveBeenCalledWith('signer volume', { result: 'removed' });
  });

  it('removes a volume with no o at all', async () => {
    const d = deps({ inspect: async () => '{}' });
    expect(await removeStaleSignerVolume(d.value)).toBe('removed');
  });

  it('keeps a volume made with the overlay’s options', async () => {
    const d = deps({ inspect: async () => `${options(OVERLAY_O)}\n` });
    expect(await removeStaleSignerVolume(d.value)).toBe('current');
    expect(d.cli).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is no volume yet', async () => {
    const d = deps({
      inspect: async () => {
        throw new Error('no such volume');
      },
    });
    expect(await removeStaleSignerVolume(d.value)).toBe('absent');
    expect(d.cli).toHaveBeenCalledTimes(1);
  });

  it('reports a failed removal without throwing', async () => {
    const d = deps({
      inspect: async () => options('uid=501,gid=20,mode=0700,size=1m'),
      rm: async () => {
        throw new Error('volume is being used');
      },
    });
    expect(await removeStaleSignerVolume(d.value)).toBe('remove_failed');
    expect(d.log).toHaveBeenCalledWith('signer volume', { result: 'remove_failed' });
  });

  it('leaves Docker alone', async () => {
    const d = deps({ kind: 'docker' });
    expect(await removeStaleSignerVolume(d.value)).toBe('not_podman');
    expect(d.cli).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });

  it('removes a volume made from the stack’s unlabelled CR 0042 R2 options', async () => {
    const r2 = V0316_COMPOSE.replace(
      'o: "uid=${HERMES_UID:-1000},gid=${HERMES_GID:-1000},mode=0700,size=1m"',
      'o: "mode=1777,size=1m"'
    );
    expect(r2).not.toBe(V0316_COMPOSE);
    const d = deps({ compose: r2, inspect: async () => options('mode=1777,size=1m') });
    expect(await removeStaleSignerVolume(d.value)).toBe('removed');
  });

  it('stops once the stack’s volume options need no override', async () => {
    const fixed = V0316_COMPOSE.replace(
      'o: "uid=${HERMES_UID:-1000},gid=${HERMES_GID:-1000},mode=0700,size=1m"',
      'o: "mode=1777,size=1m,context=system_u:object_r:container_file_t:s0"'
    );
    expect(fixed).not.toBe(V0316_COMPOSE);
    const d = deps({ compose: fixed });
    expect(await removeStaleSignerVolume(d.value)).toBe('no_override');
    expect(d.cli).not.toHaveBeenCalled();
  });
});
