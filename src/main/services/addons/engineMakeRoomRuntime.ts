import {
  announceAssistantStackMakingRoom,
  ensureAssistantStackAndApplyLlm,
  stopAssistantStack,
} from '../assistant/AssistantStackService';
import {
  getContainerRuntime,
  resetContainerRuntimeCache,
  stopBundledMachineIfStarted,
} from '../containerRuntime';
import type { MakeRoomDeps } from './engineMakeRoom';

/** Make room against the running stack and Boundary's own Podman machine. */
export function createDefaultMakeRoomDeps(): MakeRoomDeps {
  return {
    engineResizable: async () => {
      const runtime = await getContainerRuntime();
      return runtime.origin === 'bundled' && runtime.kind === 'podman';
    },
    announce: announceAssistantStackMakingRoom,
    stopStack: async () => {
      const stopped = await stopAssistantStack({ quiet: true });
      if (!stopped.success) throw new Error(stopped.error ?? 'The assistant stack did not stop.');
    },
    stopMachine: async () => {
      await stopBundledMachineIfStarted();
      // The next start resolves the runtime again, which starts the machine at its new size.
      resetContainerRuntimeCache();
    },
    startStack: async () => {
      const started = await ensureAssistantStackAndApplyLlm();
      return { success: started.success, error: started.error };
    },
  };
}
