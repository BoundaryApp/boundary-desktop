import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSlotLlmConnection } from '../../onboarding/OpenAiOnboardingStore';
import { mintMemberKeys, revokeMemberKeys } from '../../addons/twentyMemberKeys';
import { twentyPort } from '../../addons/twentySignIn';
import { tryResolveAssistantRoot } from '../../assistant/resolveAssistantRoot';
import { resolveAssistantStackHome } from '../../assistant/assistantPaths';
import { folderFacts, refuseCodingGrantReason } from '../../assistant/coding/codingGrantRules';
import { getStackEndpoints, stackFilesAt } from '../../stackHost/activeStack';
import { hasStackCapability, requireStackCapability } from '../../stackHost/capabilities';
import { checkAgentRequest, readLimitedBody } from '../../hostBridge/requestGuard';
import { localServiceUpstream } from '../../circles/sharedServices';
import { boundaryCircleSharing } from '../circleSharing';

vi.mock('electron', () => ({ app: { getPath: () => '/user-data' } }));
vi.mock('../../onboarding/OpenAiOnboardingStore', () => ({ getSlotLlmConnection: vi.fn() }));
vi.mock('../../addons/twentyMemberKeys', async (importActual) => ({
  ...(await importActual<typeof import('../../addons/twentyMemberKeys')>()),
  mintMemberKeys: vi.fn(),
  revokeMemberKeys: vi.fn(),
}));
vi.mock('../../addons/twentySignIn', () => ({ twentyPort: vi.fn() }));
vi.mock('../../addons/twentyWorkspaces', () => ({
  removeTwentyWorkspace: vi.fn(),
  setTwentyWorkspaceUrl: vi.fn(),
  twentySlugFree: vi.fn(),
  writeTwentyWorkspace: vi.fn(),
}));
vi.mock('../../addons/addonLock', () => ({ runExclusive: vi.fn() }));
vi.mock('../../addons/pendingRestart', () => ({ addPendingChange: vi.fn() }));
vi.mock('../../assistant/resolveAssistantRoot', () => ({ tryResolveAssistantRoot: vi.fn() }));
vi.mock('../../assistant/assistantPaths', () => ({ resolveAssistantStackHome: vi.fn(() => '/stack-home') }));
vi.mock('../../assistant/coding/codingGrantRules', () => ({
  folderFacts: vi.fn(() => ({ isDirectory: true, isGit: false })),
  refuseCodingGrantReason: vi.fn(() => null),
}));
vi.mock('../../stackHost/activeStack', () => ({ getStackEndpoints: vi.fn(), stackFilesAt: vi.fn((root: string) => ({ root })) }));
vi.mock('../../stackHost/capabilities', () => ({ hasStackCapability: vi.fn(() => true), requireStackCapability: vi.fn() }));

const endpoints = { portUrl: (port: number) => `http://127.0.0.1:${port}` };

describe("Boundary's Circles sharing pieces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStackEndpoints).mockReturnValue(endpoints as unknown as ReturnType<typeof getStackEndpoints>);
    vi.mocked(twentyPort).mockResolvedValue(3000);
  });

  it('shares the local model slot', async () => {
    const local = { endpointUrl: 'http://127.0.0.1:1234/v1', modelId: 'qwen3-8b' };
    vi.mocked(getSlotLlmConnection).mockResolvedValue(local as Awaited<ReturnType<typeof getSlotLlmConnection>>);
    await expect(boundaryCircleSharing().localModel()).resolves.toBe(local);
    expect(getSlotLlmConnection).toHaveBeenCalledWith('local');
  });

  describe('without the agent stack on this Mac', () => {
    beforeEach(() => {
      vi.mocked(tryResolveAssistantRoot).mockReturnValue({ root: null });
    });

    it('refuses to mint or revoke keys with no-login', async () => {
      const { services } = boundaryCircleSharing();
      await expect(services.mintKeys('Ada', 'read')).rejects.toMatchObject({
        name: 'TwentyKeyError',
        reason: 'no-login',
        message: 'The agent stack isn’t on this Mac.',
      });
      await expect(services.revokeKeys(['k1'])).rejects.toMatchObject({ reason: 'no-login' });
      expect(mintMemberKeys).not.toHaveBeenCalled();
      expect(revokeMemberKeys).not.toHaveBeenCalled();
    });

    it('gives the upstream no Twenty URL', async () => {
      await expect(boundaryCircleSharing().services.upstreamFor('twenty.main')).resolves.toEqual(
        localServiceUpstream('twenty.main', null)
      );
    });

    it('has no workspace store', () => {
      expect(boundaryCircleSharing().workspaces()).toBeNull();
    });
  });

  describe('with the agent stack at /stack', () => {
    beforeEach(() => {
      vi.mocked(tryResolveAssistantRoot).mockReturnValue({ root: '/stack' });
    });

    it("mints keys against this Mac's Twenty", async () => {
      await boundaryCircleSharing().services.mintKeys('Ada', 'write');
      expect(stackFilesAt).toHaveBeenCalledWith('/stack');
      expect(mintMemberKeys).toHaveBeenCalledWith({ root: '/stack', port: 3000, endpoints }, 'Ada', 'write');
    });

    it("points the upstream at this Mac's Twenty", async () => {
      await expect(boundaryCircleSharing().services.upstreamFor('twenty.main')).resolves.toEqual(
        localServiceUpstream('twenty.main', 'http://127.0.0.1:3000')
      );
    });

    it('has a workspace store', () => {
      expect(boundaryCircleSharing().workspaces()).not.toBeNull();
    });
  });

  it("refuses the home folder and Boundary's data folders", () => {
    boundaryCircleSharing().folders.refuseReason('/x');
    expect(refuseCodingGrantReason).toHaveBeenCalledWith('/x', {
      home: os.homedir(),
      boundaryDataPaths: ['/user-data', resolveAssistantStackHome()],
    });
    expect(boundaryCircleSharing().folders.facts('/x')).toEqual({ isDirectory: true, isGit: false });
    expect(folderFacts).toHaveBeenCalledWith('/x');
  });

  it('asks the stack host about host callbacks', () => {
    const sharing = boundaryCircleSharing();
    vi.mocked(hasStackCapability).mockReturnValue(false);
    expect(sharing.hasHostCallbacks()).toBe(false);
    expect(hasStackCapability).toHaveBeenCalledWith('hostCallbacks');
    sharing.requireHostCallbacks();
    expect(requireStackCapability).toHaveBeenCalledWith('hostCallbacks');
  });

  it("uses the host bridge's agent request guard", () => {
    const { agentGuard } = boundaryCircleSharing();
    expect(agentGuard.check).toBe(checkAgentRequest);
    expect(agentGuard.readBody).toBe(readLimitedBody);
  });
});
