import fs from 'node:fs';
import path from 'node:path';
import { resolveActiveAssistantDataRoot } from '../resolveAssistantRoot';

/**
 * WebUI keeps chats in JSON sidecars and optionally projects them into Hermes
 * state.db when sync_to_insights is true. Gateway session.list only sees
 * state.db rows — so Boundary enables this by default for stack-owned installs.
 *
 * Paths mirror nesquena/hermes-webui: $HERMES_HOME/webui/settings.json
 * (and legacy webui-state/).
 */
const SETTINGS_RELATIVE_PATHS = [
  path.join('webui', 'settings.json'),
  path.join('webui-state', 'settings.json'),
] as const;

export function resolveHermesWebuiSettingsCandidates(
  dataRoot: string = resolveActiveAssistantDataRoot()
): string[] {
  const hermesHome = path.join(dataRoot, 'hermes');
  return SETTINGS_RELATIVE_PATHS.map((rel) => path.join(hermesHome, rel));
}

/**
 * Ensure sync_to_insights is true in every known WebUI settings path.
 * Creates the primary webui/settings.json when missing.
 * Returns paths that were created or updated.
 *
 * Async: the chat list runs this every few seconds, and a local stack's data sits under
 * ~/Documents, where a blocking call on the main thread can wait on a macOS permission check.
 */
export async function ensureHermesWebuiSyncToInsights(
  dataRoot: string = resolveActiveAssistantDataRoot()
): Promise<string[]> {
  const candidates = resolveHermesWebuiSettingsCandidates(dataRoot);
  const touched: string[] = [];
  const primary = candidates[0];

  for (const settingsPath of candidates) {
    // null when the file is missing or can't be read.
    const raw = await fs.promises.readFile(settingsPath, 'utf8').catch((): null => null);
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

    await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
    const next = { ...current, sync_to_insights: true };
    await fs.promises.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    touched.push(settingsPath);
  }

  return touched;
}
