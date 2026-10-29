import type {
  AgentProfile,
  ChannelRecord,
  HermesChatThreadSummary,
  HermesMentionRecord,
  HermesProjectRecord,
} from '../../../shared/types/hermesChat';

/**
 * The chat screen's lists as they were when it last rendered. Settings, Services and
 * Resources replace the chat screen, which unmounts it; coming back seeds its state from
 * here so the rail shows the previous chats at once, and the mount refresh updates them
 * quietly. Lives for the window's lifetime only.
 */
export interface ChatScreenSnapshot {
  threads: HermesChatThreadSummary[];
  activeThreadId: string | null;
  idAliases: Record<string, string>;
  agents: AgentProfile[];
  standingDmByAgent: Record<string, string | null>;
  orchestratorSlug: string | null;
  channels: ChannelRecord[];
  mentions: HermesMentionRecord[];
  projects: HermesProjectRecord[];
  activeProjectId: string | null;
}

let snapshot: ChatScreenSnapshot | null = null;

export function readChatScreenSnapshot(): ChatScreenSnapshot | null {
  return snapshot;
}

export function saveChatScreenSnapshot(next: ChatScreenSnapshot): void {
  snapshot = next;
}

/** Tests only. */
export function clearChatScreenSnapshot(): void {
  snapshot = null;
}
