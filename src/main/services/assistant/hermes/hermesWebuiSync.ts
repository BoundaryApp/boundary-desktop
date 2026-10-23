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
 */
export function ensureHermesWebuiSyncToInsights(
  dataRoot: string = resolveActiveAssistantDataRoot()
): string[] {
  const candidates = resolveHermesWebuiSettingsCandidates(dataRoot);
  const touched: string[] = [];
  const primary = candidates[0];

  for (const settingsPath of candidates) {
    const exists = fs.existsSync(settingsPath);
    if (!exists && settingsPath !== primary) {
      continue;
    }

    let current: Record<string, unknown> = {};
    if (exists) {
      try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
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

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const next = { ...current, sync_to_insights: true };
    fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    touched.push(settingsPath);
  }

  return touched;
}
