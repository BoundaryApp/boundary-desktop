import type { StackFiles } from '../stackHost/types';
import type { ProjectEnv } from './projectEnv';
import { parseEnv, removeEnvLines, upsertEnvLines } from './stackEnv';

/**
 * setup.sh never rewrites an image key that is already in `.env`, and a Boundary install's
 * `.env` began as a copy of the stack's `.env.example`. So after a pin move the kept `.env`
 * still names the old release's images, and the new tree's patches don't apply to them
 * (stack v0.3.3: a calendar-tagged Hermes image starts without its overlays). Boundary owns
 * this `.env`, so it takes every image pin from the new tree's `.env.example`.
 */

const IMAGE_KEY = /^[A-Z][A-Z0-9_]*_IMAGE(?:_TAG)?$/;

/** `KEY=value` pairs for the image keys set (not commented out) in dotenv contents. */
export function readImagePins(contents: string): Map<string, string> {
  return new Map(Object.entries(parseEnv(contents)).filter(([key]) => IMAGE_KEY.test(key)));
}

/**
 * The changes that take every image key `.env.example` pins to its value there, and drop image
 * keys the example no longer lists (stack v0.3.3 retired `CALDAV_MCP_IMAGE`; compose falls back
 * to its own default for any key left unset). Both image tags of Hermes move together this way.
 */
function imagePinChanges(
  envContents: string,
  exampleContents: string
): { set: Record<string, string>; unset: string[] } {
  const wanted = readImagePins(exampleContents);
  // An example with no image pins means the file wasn't what we expected: change nothing.
  if (wanted.size === 0) return { set: {}, unset: [] };
  const current = readImagePins(envContents);
  return {
    set: Object.fromEntries([...wanted].filter(([key, value]) => current.get(key) !== value)),
    unset: [...current.keys()].filter((key) => !wanted.has(key)),
  };
}

/** `imagePinChanges` applied to dotenv contents. */
export function syncImagePinsFromExample(envContents: string, exampleContents: string): string {
  const { set, unset } = imagePinChanges(envContents, exampleContents);
  return upsertEnvLines(removeEnvLines(envContents, unset), set);
}

/** Apply `imagePinChanges` to the project's `.env` through `env`. True when it changed. */
export async function syncStackImagePins(files: StackFiles, env: ProjectEnv): Promise<boolean> {
  const [contents, example] = await Promise.all([
    files.readText('stack', '.env'),
    files.readText('stack', '.env.example'),
  ]);
  if (contents === null || example === null) return false;
  const { set, unset } = imagePinChanges(contents, example);
  const removed = unset.length ? await env.unset(unset) : false;
  const written = Object.keys(set).length ? await env.set(set) : false;
  return removed || written;
}
