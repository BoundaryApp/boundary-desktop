import type React from 'react';
import {
  createFakeBridge,
  fakeHermesChat,
  withIdleMain,
  type BridgeLeaves,
  type FakeBridge,
  type FakeHermesChat,
} from '../../../__tests__/fakeBridge';
import type { WorkbenchThread } from '../WorkbenchThread';
import { HermesChatRuntimeProvider } from '../HermesChatRuntimeProvider';
import { ChatRuntimeHost } from '../chatRuntimeHost';

/**
 * The chat runtime as the app mounts it: HermesChatRuntimeProvider under a ChatRuntimeHost,
 * which ProductReadyShell puts above every screen. Rerendering it keeps the same host.
 */
export function HostedChatRuntime(
  props: React.ComponentProps<typeof HermesChatRuntimeProvider>
): React.ReactElement {
  return (
    <ChatRuntimeHost>
      <HermesChatRuntimeProvider {...props} />
    </ChatRuntimeHost>
  );
}

/**
 * Main for a thread test: fakeBridge with one Hermes chat, `sessionId`, and the rest of main
 * idle. `given` goes over both; a `hermesChat` leaf in it replaces the fake chat's own. Pass a
 * function to build leaves on the chat or the bridge (a spy over `chat.leaves.getHistory`, a
 * `bridge.listen` subscription).
 */
export function installChatBridge(
  sessionId: string,
  given: BridgeLeaves | ((chat: FakeHermesChat, bridge: FakeBridge) => BridgeLeaves) = {}
): { bridge: FakeBridge; chat: FakeHermesChat } {
  const bridge = createFakeBridge();
  const chat = fakeHermesChat(bridge, sessionId);
  const leaves = typeof given === 'function' ? given(chat, bridge) : given;
  bridge.install(withIdleMain(bridge, { ...leaves, hermesChat: { ...chat.leaves, ...leaves.hermesChat } }));
  return { bridge, chat };
}

type ThreadProps = React.ComponentProps<typeof WorkbenchThread>;

const noop = (): void => undefined;

/**
 * WorkbenchThread's props for a chat with no project, tools on, and no-op handlers for the
 * project and agent-draft controls a thread test doesn't use.
 */
export function threadProps(
  props: Pick<ThreadProps, 'sessionId'> & Partial<ThreadProps>
): ThreadProps {
  return {
    threadTitle: 'Assistant',
    activeProject: null,
    projects: [],
    activeProjectId: null,
    toolsEnabled: true,
    onToolsEnabledChange: noop,
    onSelectProject: noop,
    onClearProject: noop,
    onNewProject: noop,
    onCreateAgentFromDraft: noop,
    onEditAgentDraft: noop,
    ...props,
  };
}
