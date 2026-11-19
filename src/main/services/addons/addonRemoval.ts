import fs from 'node:fs';
import path from 'node:path';
import type { AddonStepId } from '../../../shared/types/addons';
import { getContainerRuntime } from '../containerRuntime/resolveContainerRuntime';
import { runCli } from '../containerRuntime/runCli';
import { twentyWorkspacesDir } from './twentyWorkspaces';

// Pieces of "Remove and delete data" that don't touch the installer's snapshot. The installer
// runs the steps (addonInstaller.ts).

/**
 * The removal's steps. Every run stops and removes the containers before it deletes data: after
 * an app relaunch a resumed run can't tell whether an earlier one stopped them, and compose
 * `stop` and `rm` do nothing when they're gone. Only a run that starts while the add-on is
 * installed ends with a restart, so agents drop its tools. Turn off already asked for one.
 */
export function removalStepIds(wasInstalled: boolean, deleteImages: boolean): AddonStepId[] {
  return [
    'stop',
    'remove-containers',
    'delete-data',
    'delete-keys',
    ...(deleteImages ? (['delete-images'] as const) : []),
    ...(wasInstalled ? (['restart'] as const) : []),
  ];
}

/**
 * The images `services` use, from `compose config --format json`, each once. Throws when the
 * output isn't JSON or names no image for them.
 */
export function composeImages(stdout: string, services: string[]): string[] {
  const parsed = JSON.parse(stdout) as { services?: Record<string, { image?: unknown }> };
  const images = new Set<string>();
  for (const name of services) {
    const image = parsed.services?.[name]?.image;
    if (typeof image === 'string' && image) images.add(image);
  }
  if (!images.size) throw new Error(`compose config names no image for ${services.join(', ')}.`);
  return [...images];
}

/** `content` without the lines that set one of `keys`; every other line stays as it was. */
function removeEnvKeys(content: string, keys: string[]): string {
  const drop = new Set(keys);
  return content
    .split('\n')
    .filter((line) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return !(m && drop.has(m[1]));
    })
    .join('\n');
}

/**
 * Deletes the local workspace `main` from the add-on store (its settings and both keys) and the
 * owner login `crm.sh init` wrote to the stack's `.env`. Hosted workspaces stay. Missing files
 * are not an error.
 */
export function deleteTwentyKeys(root: string): void {
  const dir = twentyWorkspacesDir(root);
  for (const file of ['instances/main.json', 'secrets/main.key_ro', 'secrets/main.key_rw']) {
    fs.rmSync(path.join(dir, file), { force: true });
  }
  const envFile = path.join(root, '.env');
  if (!fs.existsSync(envFile)) return;
  const before = fs.readFileSync(envFile, 'utf8');
  const after = removeEnvKeys(before, ['TWENTY_USERNAME', 'TWENTY_PASSWORD']);
  if (after !== before) fs.writeFileSync(envFile, after);
}

function failureText(error: unknown): string {
  const e = error as { stderr?: unknown; message?: unknown };
  return `${typeof e?.stderr === 'string' ? e.stderr : ''}\n${String(e?.message ?? error)}`;
}

/**
 * Removes each image with `rm`. Docker refuses an image a container uses with "conflict",
 * Podman with "in use"; those are kept. An image already gone (Docker "No such image", Podman
 * "image not known") is skipped. Any other failure rejects.
 */
export async function removeImagesWith(
  images: string[],
  rm: (image: string) => Promise<unknown>
): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const image of images) {
    try {
      await rm(image);
      removed.push(image);
    } catch (error) {
      const text = failureText(error);
      if (/no such image|image not known/i.test(text)) continue;
      if (/in use|conflict/i.test(text)) kept.push(image);
      else throw error;
    }
  }
  return { removed, kept };
}

const IMAGE_RM_TIMEOUT_MS = 120_000;

/** {@link removeImagesWith} through the container runtime's CLI (`image rm`). */
export async function removeImagesOnRuntime(images: string[]): Promise<{ removed: string[]; kept: string[] }> {
  const runtime = await getContainerRuntime();
  return removeImagesWith(images, (image) => runCli(runtime, ['image', 'rm', image], { timeout: IMAGE_RM_TIMEOUT_MS }));
}
