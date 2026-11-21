import path from 'node:path';
import { persistDebugLog } from '../../persistDebugLog';
import { onBeforeStackUp } from '../assistant/hermesLifecycle';
import { getStackFiles } from '../stackHost/activeStack';
import { readStackFile } from './addonScript';
import { bitwardenBrokerToken } from './bitwardenFolders';
import { runPlainOnStack, stackPaths } from './stackScripts';
import { ensureStackTokenSources, type TokenSource } from './stackTokenSources';

const TOKEN_SCRIPT_TIMEOUT_MS = 60_000;

async function browserTokens(): Promise<TokenSource[]> {
  const files = getStackFiles();
  return Promise.all(
    ['agent', 'credentials'].map(async (name): Promise<TokenSource> => {
      const rel = `web-browser/secrets/${name}`;
      const stat = await files.stat('userContent', rel);
      const state = !stat ? 'missing' : stat.kind === 'folder' ? 'folder' : stat.size > 0 ? 'file' : 'missing';
      return { path: path.join(stackPaths().dataRoot, rel), state };
    })
  );
}

/** Creates the token files stack v0.3.16 bind-mounts, before each `up`. Call once at startup; returns the unsubscribe function. */
export function registerStackTokenSources(): () => void {
  return onBeforeStackUp(() =>
    ensureStackTokenSources({
      hasTokenScripts: async () => (await readStackFile(getStackFiles(), 'scripts/web-browser-secrets.sh')) !== null,
      browserTokens,
      brokerToken: () => bitwardenBrokerToken(stackPaths().root),
      run: (script, args) => runPlainOnStack(script, args, { timeoutMs: TOKEN_SCRIPT_TIMEOUT_MS }),
      log: (message, data) => persistDebugLog('assistant-stack', message, data),
    })
  );
}
