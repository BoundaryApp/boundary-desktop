import fs from 'node:fs';
import path from 'node:path';
import { persistDebugLog } from '../../persistDebugLog';
import { readAssistantEnvFile, resolveAssistantDataRoot, resolveAssistantProjectRoot } from '../assistant/assistantPaths';
import { decryptCalendarPassword, listCalendarAccounts } from '../assistant/calendar/calendarStore';
import { readEnvFile } from '../assistant/stackEnv';
import { storedHostBridgeTokens } from '../hostBridge/hostBridgeStore';
import { ConfidentialStore } from '../inference/confidential/confidentialStore';
import { storedApiKeys } from '../onboarding/OpenAiOnboardingStore';
import { storedUpdateFeedKey } from '../updates/ipcHandlers';

/** One place Boundary keeps secrets, read for masking a report. */
export interface SecretSource {
  name: string;
  read: () => Promise<Array<string | null | undefined>>;
}

/** Placeholder keys local model servers accept. They are words, not secrets. */
const NOT_SECRET = new Set(['ollama', 'lm-studio']);

/** Env names whose values are credentials. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;

function secretEnvValues(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([name]) => SECRET_NAME.test(name))
    .map(([, value]) => value);
}

/** The stack's `.env`, Hermes's and each Hermes profile's. */
function stackEnvSecrets(): string[] {
  const projectRoot = resolveAssistantProjectRoot();
  const hermesHome = path.join(resolveAssistantDataRoot(projectRoot), 'hermes');
  const envs = [readAssistantEnvFile(projectRoot), readEnvFile(path.join(hermesHome, '.env'))];
  let profiles: string[] = [];
  try {
    profiles = fs.readdirSync(path.join(hermesHome, 'profiles'));
  } catch {
    // No profiles yet.
  }
  for (const profile of profiles) envs.push(readEnvFile(path.join(hermesHome, 'profiles', profile, '.env')));
  return envs.flatMap(secretEnvValues);
}

async function confidentialKeys(): Promise<Array<string | null>> {
  const store = new ConfidentialStore();
  return Promise.all(store.addedProviders().map((id) => store.apiKey(id)));
}

const SECRET_SOURCES: SecretSource[] = [
  { name: 'model keys', read: storedApiKeys },
  { name: 'host bridge tokens', read: storedHostBridgeTokens },
  { name: 'calendar passwords', read: () => Promise.all(listCalendarAccounts().map(decryptCalendarPassword)) },
  { name: 'confidential keys', read: confidentialKeys },
  { name: 'update key', read: async () => [await storedUpdateFeedKey()] },
  { name: 'stack env', read: async () => stackEnvSecrets() },
];

/**
 * Secret values Boundary stores, so a report can mask them whatever their shape. A source that
 * fails is logged by name and skipped; the pattern rules still apply to the report.
 */
export async function storedSecretValues(sources: SecretSource[] = SECRET_SOURCES): Promise<string[]> {
  const found = new Set<string>();
  await Promise.all(
    sources.map(async (source) => {
      try {
        for (const value of await source.read()) {
          const secret = value?.trim();
          if (secret && !NOT_SECRET.has(secret)) found.add(secret);
        }
      } catch (error) {
        persistDebugLog('bug-report', 'secret source unreadable', {
          source: source.name,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    })
  );
  return [...found];
}
