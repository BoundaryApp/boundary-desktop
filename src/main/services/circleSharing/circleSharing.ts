/**
 * Boundary's side of Circles sharing: which model, Twenty and its workspaces, the coding-folder
 * rules and the host bridge's guard. Circles reads these through its configuration point.
 */
import os from 'node:os';
import { app } from 'electron';
import { runExclusive } from '../addons/addonLock';
import { addPendingChange } from '../addons/pendingRestart';
import { mintMemberKeys, revokeMemberKeys, TwentyKeyError, type TwentyKeyDeps } from '../addons/twentyMemberKeys';
import { twentyPort } from '../addons/twentySignIn';
import {
  removeTwentyWorkspace,
  setTwentyWorkspaceUrl,
  twentySlugFree,
  writeTwentyWorkspace,
} from '../addons/twentyWorkspaces';
import { resolveAssistantStackHome } from '../assistant/assistantPaths';
import { folderFacts, refuseCodingGrantReason } from '../assistant/coding/codingGrantRules';
import { tryResolveAssistantRoot } from '../assistant/resolveAssistantRoot';
import { localServiceUpstream } from '../circles/sharedServices';
import { configureCircles, type CirclesSharing } from '../circles/sharingConfig';
import type { WorkspaceStore } from '../circles/usedServices';
import { checkAgentRequest, readLimitedBody } from '../hostBridge/requestGuard';
import { getSlotLlmConnection } from '../onboarding/OpenAiOnboardingStore';
import { getStackEndpoints, stackFilesAt } from '../stackHost/activeStack';
import { hasStackCapability, requireStackCapability } from '../stackHost/capabilities';

/** Reaches this Mac's Twenty as its owner, for members' keys. */
async function twentyKeyDeps(): Promise<TwentyKeyDeps> {
  const { root } = tryResolveAssistantRoot();
  if (!root) throw new TwentyKeyError('no-login', 'The agent stack isn’t on this Mac.');
  return { root, port: await twentyPort(stackFilesAt(root)), endpoints: getStackEndpoints() };
}

function workspaceStore(): WorkspaceStore | null {
  const { root } = tryResolveAssistantRoot();
  if (!root) return null;
  const files = stackFilesAt(root);
  return {
    slugFree: (slug) => twentySlugFree(files, slug),
    exists: async (slug) => !(await twentySlugFree(files, slug)),
    write: (slug, values, keys) => writeTwentyWorkspace(files, slug, values, keys),
    setUrl: (slug, url) => setTwentyWorkspaceUrl(files, slug, url),
    remove: (slug) => removeTwentyWorkspace(files, slug),
  };
}

export function boundaryCircleSharing(): CirclesSharing {
  return {
    localModel: () => getSlotLlmConnection('local'),
    services: {
      mintKeys: async (name, level) => mintMemberKeys(await twentyKeyDeps(), name, level),
      revokeKeys: async (ids) => revokeMemberKeys(await twentyKeyDeps(), ids),
      upstreamFor: async (service) => {
        const { root } = tryResolveAssistantRoot();
        return localServiceUpstream(service, root ? getStackEndpoints().portUrl(await twentyPort(stackFilesAt(root))) : null);
      },
    },
    workspaces: workspaceStore,
    pending: addPendingChange,
    exclusive: runExclusive,
    hasHostCallbacks: () => hasStackCapability('hostCallbacks'),
    requireHostCallbacks: () => requireStackCapability('hostCallbacks'),
    folders: {
      // The coding-folder rules (ADR 0028 §5), with the same home and Boundary data folders.
      refuseReason: (hostPath) =>
        refuseCodingGrantReason(hostPath, {
          home: os.homedir(),
          boundaryDataPaths: [app.getPath('userData'), resolveAssistantStackHome()],
        }),
      facts: folderFacts,
    },
    agentGuard: { check: checkAgentRequest, readBody: readLimitedBody },
  };
}

export function configureCircleSharing(): void {
  configureCircles(boundaryCircleSharing());
}
