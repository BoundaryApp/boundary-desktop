import { parseEnv, upsertEnvLines } from '../assistant/stackEnv';
import type { StackFiles } from '../stackHost/types';

/** Which stack roots a once-only `.env` move already ran for. */
export interface EnvMoveRecord {
  moved(root: string): boolean;
  markMoved(root: string): void;
}

/**
 * Writes the flags `values` picks into the stack's `.env` and marks `root` as moved. `values`
 * gets whether the move already ran for `root` and `.env`'s current values, and returns the
 * flags to write. Returns them; none, and nothing marked, when the stack has no `.env`.
 */
export async function moveFlagsToEnv(
  files: StackFiles,
  root: string,
  record: EnvMoveRecord,
  values: (moved: boolean, current: Record<string, string>) => Record<string, string> | Promise<Record<string, string>>
): Promise<Record<string, string>> {
  const before = await files.readText('stack', '.env');
  if (before === null) return {};
  const moved = record.moved(root);
  const written = await values(moved, parseEnv(before));
  if (Object.keys(written).length > 0) {
    const after = upsertEnvLines(before, written);
    if (after !== before) await files.writeText('stack', '.env', after);
  }
  if (!moved) record.markMoved(root);
  return written;
}
