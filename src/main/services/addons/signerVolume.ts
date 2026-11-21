import { BOUNDARY_ASSISTANT_PROJECT_NAME } from '../../../shared/assistantStackConstants';
import { podmanVolumeOverrides } from '../assistant/engineOverlay';
import type { RuntimeKind } from '../containerRuntime/types';

// Change request 0042 R2: on Podman the engine overlay gives the bitwarden_signin volume mount
// options the signer can bind its socket under. A volume Podman made before that overlay keeps its
// old options: compose sees the changed config and asks whether to recreate it, and without a
// terminal the answer is no, so the signer keeps exiting 2. Before Bitwarden's services come up,
// this removes such a volume so compose makes it again with the overlay's options.
//
// Podman records a volume's `o` in its Options (pkg/domain/infra/abi/parse/parse.go), so a volume
// whose `o` differs from the overlay's was made from other options. `volume rm --force` also removes
// the containers that mount it (bitwarden-signin and bitwarden-broker); compose recreates both in
// the same `up`. The volume holds only the signer's socket, on a tmpfs.

const VOLUME = 'bitwarden_signin';

/** The volume's name in Boundary's compose project. */
export const SIGNER_VOLUME_NAME = `${BOUNDARY_ASSISTANT_PROJECT_NAME}_${VOLUME}`;

export interface SignerVolumeDeps {
  runtimeKind(): Promise<RuntimeKind>;
  /** The stack's `docker-compose.yml`. */
  composeText(): Promise<string>;
  /** The container CLI; rejects on a non-zero exit. */
  cli(args: string[]): Promise<string>;
  /** Metadata only. */
  log(message: string, data: Record<string, unknown>): void;
}

export type SignerVolumeResult = 'not_podman' | 'no_override' | 'absent' | 'current' | 'removed' | 'remove_failed';

/** The `o` in a volume's `{{json .Options}}`, or null when there is none. */
export function volumeMountOption(optionsJson: string): string | null {
  try {
    const options = JSON.parse(optionsJson) as Record<string, unknown> | null;
    return typeof options?.o === 'string' ? options.o : null;
  } catch {
    return null;
  }
}

/**
 * Removes the signer's volume when Podman holds one made with options other than the overlay's.
 * Never throws: a failure is logged, and compose's own `up` then reports what is wrong.
 */
export async function removeStaleSignerVolume(deps: SignerVolumeDeps): Promise<SignerVolumeResult> {
  const result = await check(deps);
  if (result !== 'not_podman' && result !== 'no_override') deps.log('signer volume', { result });
  return result;
}

async function check(deps: SignerVolumeDeps): Promise<SignerVolumeResult> {
  if ((await deps.runtimeKind()) !== 'podman') return 'not_podman';
  const wanted = podmanVolumeOverrides(await deps.composeText()).get(VOLUME);
  if (!wanted) return 'no_override';
  let optionsJson: string;
  try {
    optionsJson = await deps.cli(['volume', 'inspect', SIGNER_VOLUME_NAME, '--format', '{{json .Options}}']);
  } catch {
    // No such volume, or no answer from Podman; compose's `up` reports the latter.
    return 'absent';
  }
  if (volumeMountOption(optionsJson.trim()) === wanted) return 'current';
  try {
    await deps.cli(['volume', 'rm', '--force', SIGNER_VOLUME_NAME]);
    return 'removed';
  } catch {
    return 'remove_failed';
  }
}
