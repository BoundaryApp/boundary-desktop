import type { TwentyAccess, TwentyWorkspace } from '../../../shared/types/addons';
import { getAssistantStackAccess } from '../assistant/AssistantStackService';
import { tryResolveAssistantRoot } from '../assistant/resolveAssistantRoot';
import { stackFilesAt } from '../stackHost/activeStack';
import type { StackCommands } from '../stackHost/types';
import { runExclusive } from './addonInstaller';
import {
  connectTwentyWorkspace,
  disconnectTwentyWorkspace,
  runCrmScript,
  type TwentyConnectInput,
  type TwentyConnectResult,
} from './crmScript';
import { addPendingChange, removePendingChanges } from './pendingRestart';
import { listTwentyWorkspaces, setTwentyWorkspaceAccess, syncTwentyMcpFlag } from './twentyWorkspaces';

export interface TwentyServiceDeps {
  /** The active stack root, or null while none resolves. */
  root(): string | null;
  /** The environment the stack's scripts run with. */
  baseEnv(): Promise<NodeJS.ProcessEnv>;
  /** The stack host's `runScript`. */
  runScript: StackCommands['runScript'];
  run: typeof runCrmScript;
}

export interface TwentyService {
  listWorkspaces(): Promise<TwentyWorkspace[]>;
  /** Adds a hosted workspace with crm.sh. Agents get it at the next assistant restart. */
  connect(input: TwentyConnectInput): Promise<TwentyConnectResult>;
  /** Deletes a hosted workspace's file with crm.sh. Refuses this Mac's own workspace. */
  disconnect(slug: string): Promise<void>;
  setAccess(slug: string, access: TwentyAccess): Promise<void>;
}

const ACCESS_LABEL: Record<TwentyAccess, string> = {
  read: 'look things up',
  write: 'make changes',
};

/**
 * Twenty workspace changes. Each one waits for the next assistant restart, so it adds a line
 * to the pending list, and runs under the installer's lock so it can't overlap other add-on work.
 */
export function createTwentyService(deps: TwentyServiceDeps): TwentyService {
  const requireRoot = (): string => {
    const root = deps.root();
    if (!root) throw new Error('The agent stack folder could not be found.');
    return root;
  };


  // crm.sh copies TWENTY_WORKSPACE_URL from its environment into the file it writes, so a value
  // in the stack's environment must not reach a hosted workspace's file.
  const scriptEnv = async (): Promise<NodeJS.ProcessEnv> => {
    const env = { ...(await deps.baseEnv()) };
    delete env.TWENTY_WORKSPACE_URL;
    return env;
  };

  return {
    listWorkspaces: async () => {
      const root = deps.root();
      return root ? listTwentyWorkspaces(stackFilesAt(root)) : [];
    },

    connect: (input) =>
      runExclusive(async () => {
        requireRoot();
        const result = await connectTwentyWorkspace(deps.runScript, await scriptEnv(), input, deps.run);
        if (result.ok) addPendingChange(`Connect crm-${input.slug} (${ACCESS_LABEL[input.access]})`);
        return result;
      }),

    disconnect: (slug) =>
      runExclusive(async () => {
        const root = requireRoot();
        const workspace = (await listTwentyWorkspaces(stackFilesAt(root))).find((w) => w.slug === slug);
        if (workspace?.local) {
          throw new Error(`crm-${slug} is this Mac’s Twenty. Turn it off on its card instead.`);
        }
        await disconnectTwentyWorkspace(deps.runScript, await scriptEnv(), slug, deps.run);
        // crm.sh remove leaves TWENTY_MCP_ENABLED as it was.
        await syncTwentyMcpFlag(stackFilesAt(root));
        addPendingChange(`Disconnect crm-${slug}`);
      }),

    setAccess: (slug, access) =>
      runExclusive(async () => {
        await setTwentyWorkspaceAccess(stackFilesAt(requireRoot()), slug, access);
        const prefix = `crm-${slug}: `;
        removePendingChanges((text) => text.startsWith(prefix));
        addPendingChange(`${prefix}${ACCESS_LABEL[access]}`);
      }),
  };
}

let shared: TwentyService | null = null;

/** The app's one workspace service, on the active stack. */
export function getTwentyService(): TwentyService {
  shared ??= createTwentyService({
    root: () => tryResolveAssistantRoot().root ?? null,
    baseEnv: () => getAssistantStackAccess().scriptEnv([]),
    runScript: (script, args, options) => getAssistantStackAccess().runScript(script, args, options),
    run: runCrmScript,
  });
  return shared;
}
