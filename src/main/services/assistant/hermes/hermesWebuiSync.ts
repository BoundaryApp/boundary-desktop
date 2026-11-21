import { getStackFiles } from '../../stackHost/activeStack';
import type { StackFiles } from '../../stackHost/types';

/**
 * WebUI keeps chats in JSON sidecars and optionally projects them into Hermes
 * state.db when sync_to_insights is true. Gateway session.list only sees
 * state.db rows — so Boundary enables this by default for stack-owned installs.
 *
 * Paths mirror nesquena/hermes-webui: $HERMES_HOME/webui/settings.json
 * (and legacy webui-state/).
 */
const SETTINGS_RELATIVE_PATHS = [
  'hermes/webui/settings.json',
  'hermes/webui-state/settings.json',
] as const;

/** The settings files, relative to the stack's `data` folder; the first is the primary one. */
export function resolveHermesWebuiSettingsCandidates(): readonly string[] {
  return SETTINGS_RELATIVE_PATHS;
}

/**
 * Ensure sync_to_insights is true in every known WebUI settings path.
 * Creates the primary webui/settings.json when missing.
 * Returns paths (relative to `data`) that were created or updated.
 *
 * Async: the chat list runs this every few seconds, and a local stack's data sits under
 * ~/Documents, where a blocking call on the main thread can wait on a macOS permission check.
 */
export async function ensureHermesWebuiSyncToInsights(
  files: StackFiles = getStackFiles()
): Promise<string[]> {
  const candidates = resolveHermesWebuiSettingsCandidates();
  const touched: string[] = [];
  const primary = candidates[0];

  for (const settingsPath of candidates) {
    // null when the file is missing or can't be read.
    const raw = await files.readText('data', settingsPath).catch((): null => null);
    if (raw === null && settingsPath !== primary) {
      continue;
    }

    let current: Record<string, unknown> = {};
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        current = {};
      }
    }

    if (current.sync_to_insights === true) {
      continue;
    }

    const next = { ...current, sync_to_insights: true };
    await files.writeText('data', settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    touched.push(settingsPath);
  }

  return touched;
}
