import fs from 'node:fs';
import path from 'node:path';
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
 * Set each image key `.env.example` pins to its value there, and drop image keys the example
 * no longer lists (stack v0.3.3 retired `CALDAV_MCP_IMAGE`; compose falls back to its own
 * default for any key left unset). Both image tags of Hermes move together this way.
 */
export function syncImagePinsFromExample(envContents: string, exampleContents: string): string {
  const wanted = readImagePins(exampleContents);
  // An example with no image pins means the file wasn't what we expected: change nothing.
  if (wanted.size === 0) return envContents;
  const current = readImagePins(envContents);
  const next = removeEnvLines(
    envContents,
    [...current.keys()].filter((key) => !wanted.has(key))
  );
  const changed = [...wanted].filter(([key, value]) => current.get(key) !== value);
  return upsertEnvLines(next, Object.fromEntries(changed));
}

/** Apply `syncImagePinsFromExample` to the project's `.env`. True when it changed. */
export async function syncStackImagePins(projectRoot: string): Promise<boolean> {
  const envPath = path.join(projectRoot, '.env');
  const examplePath = path.join(projectRoot, '.env.example');
  if (!fs.existsSync(envPath) || !fs.existsSync(examplePath)) return false;
  const [contents, example] = await Promise.all([
    fs.promises.readFile(envPath, 'utf8'),
    fs.promises.readFile(examplePath, 'utf8'),
  ]);
  const next = syncImagePinsFromExample(contents, example);
  if (next === contents) return false;
  await fs.promises.writeFile(envPath, next, 'utf8');
  return true;
}
