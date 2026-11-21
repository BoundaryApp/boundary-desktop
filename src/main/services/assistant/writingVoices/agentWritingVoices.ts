import crypto from 'node:crypto';
import type { AgentProfile, HermesSessionWritingVoice } from '../../../../shared/types/hermesChat';
import type { AgentWritingVoices, WritingVoiceUser } from '../../../../shared/types/writingVoices';
import { CLIENT_CONTEXT_MAX_CHARS } from '../../../../shared/assistantStackConstants';
import { persistDebugLog } from '../../../persistDebugLog';
import type { TurnVoiceLog } from '../hermes/hermesTurnLog';
import {
  appendSessionWritingVoiceMark,
  getRoomVoiceSent,
  getSessionWritingVoice,
  getStoredAgent,
  listSessionWritingVoiceMarks,
  listSessionsKeepingWritingVoice,
  listStoredAgents,
  setSessionWritingVoice,
  updateStoredAgentVoices,
} from '../hermes/hermesAgentStore';
import { writingVoiceFiles, writingVoiceRel } from './writingVoicePaths';
import { listWritingVoiceRecords } from './writingVoiceStore';
import { checkWritingVoiceStyle, splitFrontmatter } from './writingVoiceStyle';

const CHAT_HEADER =
  '[Boundary writing voice] Write every reply in this conversation in the writing voice below: ' +
  "the person's own style guide. Hold to its rules, especially \"Never does\".";

const draftsLine = (id: string) =>
  '[Boundary drafts voice] When you write something for the person to use elsewhere (a post, an email, a document), ' +
  `use the write-in-voice skill with the voice in /opt/voice/${id}/.`;

type Deps = { contentRoot?: string };

/** Tell every window the agents changed, so open pickers and the inspector reload. */
function notifyAgentsChanged(): void {
  void import('../../windows').then(({ broadcast }) => broadcast('hermes-agents:changed'));
}

/** A voice an agent can use: Boundary knows it and its STYLE.md checks out. */
async function readyVoice(id: string, deps: Deps): Promise<boolean> {
  if (!listWritingVoiceRecords().some((v) => v.id === id)) return false;
  const check = await checkWritingVoiceStyle(writingVoiceFiles(deps.contentRoot), writingVoiceRel(id));
  return 'style' in check;
}

async function styleBody(id: string, deps: Deps): Promise<string | null> {
  if (!(await readyVoice(id, deps))) return null;
  try {
    const text = await writingVoiceFiles(deps.contentRoot).readText('userContent', `${writingVoiceRel(id)}/STYLE.md`);
    if (text === null) return null;
    return splitFrontmatter(text).body.replace(/^\s+/, '');
  } catch {
    return null;
  }
}

const KEPT_HEADER =
  '[Boundary writing voice] Write every reply in this conversation, including any draft in it, in the writing voice below: ' +
  "the person's own style guide. Hold to its rules, especially \"Never does\".";

const MESSAGE_HEADER =
  '[Boundary writing voice for this message] Write your whole reply to the message this is sent with, ' +
  'including any draft in it, in the writing voice below, instead of any other writing voice for this reply. ' +
  'Hold to its rules, especially "Never does".';

function voiceName(id: string): string | null {
  return listWritingVoiceRecords().find((v) => v.id === id)?.name ?? null;
}

/** Guide and drafts line joined; over the budget, the drafts line alone, or nothing. */
function fit(
  guide: string | null,
  drafts: string | null,
  log: Record<string, unknown>,
  budget = CLIENT_CONTEXT_MAX_CHARS
): { text: string | null; guideSent: boolean } {
  const parts = [guide, drafts].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return { text: null, guideSent: false };
  const joined = parts.join('\n\n');
  if (joined.length <= budget) return { text: joined, guideSent: Boolean(guide) };
  persistDebugLog('writing-voices', 'context too long', { ...log, chars: joined.length, budget });
  return { text: drafts && drafts.length <= budget ? drafts : null, guideSent: false };
}

/** The turn log's voice field: ids, where it came from and its size, never its text. */
function voiceLog(
  source: TurnVoiceLog['source'],
  guideId: string | null,
  draftsId: string | null,
  result: { text: string | null; guideSent: boolean },
  reminder = false
): TurnVoiceLog | null {
  if (!result.text) return null;
  return {
    source,
    voiceId: result.guideSent ? guideId : null,
    draftsVoiceId: draftsId,
    guide: !result.guideSent ? 'none' : reminder ? 'reminder' : 'full',
    chars: result.text.length,
  };
}

/**
 * Session context for a chat (ADR 0056 §6–§7) and the voice its guide is in. A voice kept for
 * the chat replaces the agent's two; otherwise the agent's Chat replies guide and Drafts line.
 * Null text clears anything sent earlier.
 */
export async function resolveSessionWritingVoice(
  agentSlug: string,
  deps: Deps & { keptVoiceId?: string | null } = {}
): Promise<{ text: string | null; voiceName: string | null; log: TurnVoiceLog | null }> {
  const kept = deps.keptVoiceId ?? null;
  if (kept) {
    const body = await styleBody(kept, deps);
    if (body) {
      const result = fit(`${KEPT_HEADER}\n\n${body}`, draftsLine(kept), { agentSlug, voiceId: kept });
      return {
        text: result.text,
        voiceName: result.guideSent ? voiceName(kept) : null,
        log: voiceLog('kept', kept, kept, result),
      };
    }
  }
  const agent = getStoredAgent(agentSlug);
  if (!agent) return { text: null, voiceName: null, log: null };
  const chatId = agent.chatRepliesVoiceId ?? null;
  const draftsId = agent.draftsVoiceId ?? null;
  const chat = chatId ? await styleBody(chatId, deps) : null;
  const drafts = draftsId && (await readyVoice(draftsId, deps)) ? draftsLine(draftsId) : null;
  const result = fit(chat ? `${CHAT_HEADER}\n\n${chat}` : null, drafts, { agentSlug, voiceId: chatId });
  return {
    text: result.text,
    voiceName: result.guideSent && chatId ? voiceName(chatId) : null,
    log: voiceLog('agent', chat ? chatId : null, drafts ? draftsId : null, result),
  };
}

/** Turn context for one message sent with a voice chip (ADR 0056 §7); null if it isn't ready. */
export async function writingVoiceTurnContext(
  voiceId: string,
  deps: Deps = {}
): Promise<{ text: string; voiceName: string; log: TurnVoiceLog } | null> {
  const body = await styleBody(voiceId, deps);
  const name = voiceName(voiceId);
  if (!body || !name) return null;
  const result = fit(`${MESSAGE_HEADER}\n\n${body}`, draftsLine(voiceId), { voiceId, turn: true });
  if (!result.text) return null;
  return { text: result.text, voiceName: name, log: voiceLog('message', voiceId, voiceId, result)! };
}

/** A chat's kept voice, as null once it stops being ready. */
export async function getChatWritingVoice(
  sessionId: string,
  deps: Deps = {}
): Promise<HermesSessionWritingVoice> {
  const stored = getSessionWritingVoice(sessionId);
  const ready = stored ? await readyVoice(stored, deps) : false;
  return {
    voiceId: ready ? stored : null,
    voiceName: ready && stored ? voiceName(stored) : null,
    marks: listSessionWritingVoiceMarks(sessionId),
  };
}

/** Keep a voice for a chat, or clear it with null; one mark per change (ADR 0056 §6). */
export async function setChatWritingVoice(
  sessionId: string,
  voiceId: string | null,
  deps: Deps = {}
): Promise<{ success: true; voice: HermesSessionWritingVoice } | { success: false; error: string }> {
  if (voiceId && !(await readyVoice(voiceId, deps))) {
    return { success: false, error: "Pick a voice that's ready." };
  }
  const before = getSessionWritingVoice(sessionId);
  if (before !== voiceId) {
    setSessionWritingVoice(sessionId, voiceId);
    appendSessionWritingVoiceMark(sessionId, {
      kind: voiceId ? 'kept' : 'cleared',
      voiceId,
      voiceName: voiceId ? voiceName(voiceId) : null,
    });
    persistDebugLog('writing-voices', 'chat voice', { sessionId, voiceId });
  }
  return { success: true, voice: await getChatWritingVoice(sessionId, deps) };
}

/** Set an agent's two voices; works for the built-in agent's stored record too. */
export async function setAgentWritingVoices(
  slug: string,
  voices: AgentWritingVoices,
  deps: Deps & { notify?: () => void } = {}
): Promise<{ success: true; agent: AgentProfile } | { success: false; error: string }> {
  const agent = getStoredAgent(slug);
  if (!agent) return { success: false, error: 'No such agent.' };
  for (const id of [voices.chatRepliesVoiceId, voices.draftsVoiceId]) {
    if (id && !(await readyVoice(id, deps))) return { success: false, error: "Pick a voice that's ready." };
  }
  const next = updateStoredAgentVoices(slug, voices);
  if (!next) return { success: false, error: 'No such agent.' };
  (deps.notify ?? notifyAgentsChanged)();
  persistDebugLog('writing-voices', 'agent voices', {
    agentSlug: slug,
    chatRepliesVoiceId: voices.chatRepliesVoiceId,
    draftsVoiceId: voices.draftsVoiceId,
  });
  return { success: true, agent: next };
}

/** The agents that use a voice, and for what; the delete sheet names them (ADR 0056 §10). */
export function writingVoiceUsers(id: string): WritingVoiceUser[] {
  return listStoredAgents()
    .map((agent) => ({
      slug: agent.slug,
      displayName: agent.displayName,
      uses: [
        ...(agent.chatRepliesVoiceId === id ? (['chat-replies'] as const) : []),
        ...(agent.draftsVoiceId === id ? (['drafts'] as const) : []),
      ],
    }))
    .filter((user) => user.uses.length > 0);
}

/** After a voice is deleted, the agents that used it go back to No voice. */
export function clearWritingVoiceFromAgents(id: string, deps: { notify?: () => void } = {}): void {
  let changed = false;
  for (const agent of listStoredAgents()) {
    if (agent.chatRepliesVoiceId !== id && agent.draftsVoiceId !== id) continue;
    updateStoredAgentVoices(agent.slug, {
      chatRepliesVoiceId: agent.chatRepliesVoiceId === id ? null : (agent.chatRepliesVoiceId ?? null),
      draftsVoiceId: agent.draftsVoiceId === id ? null : (agent.draftsVoiceId ?? null),
    });
    changed = true;
  }
  if (changed) (deps.notify ?? notifyAgentsChanged)();
}

/** After a voice is deleted, chats that kept it go back to their agent's voice; returns how many. */
export function clearWritingVoiceFromChats(id: string): number {
  const sessions = listSessionsKeepingWritingVoice(id);
  for (const sessionId of sessions) {
    setSessionWritingVoice(sessionId, null);
    appendSessionWritingVoiceMark(sessionId, { kind: 'cleared', voiceId: null, voiceName: null });
  }
  return sessions.length;
}

const ROOM_HEADER =
  "[Boundary writing voice] Write your reply in this room in the writing voice below: the person's own style guide. " +
  'Hold to its rules, especially "Never does".';

type RoomVoicePart = {
  text: string | null;
  voiceName: string | null;
  sentHash: string | null;
  log: TurnVoiceLog | null;
};

/** Names whose guide this is: a room's history holds several members' guides, each replayed. */
const roomLabel = (member: string, voice: string) => `[Boundary writing voice for ${member}: ${voice}]`;

const roomReminder = (member: string, voice: string) =>
  `${roomLabel(member, voice)} Keep writing in the ${voice} voice given earlier in this room.`;

/**
 * One room member's writing voice for its turn context (ADR 0056 §7): the message chip's, else
 * the room's kept voice, else the member's own. A full guide goes once per room, member and
 * guide text; later turns get a reminder, since turn context is replayed with its row. It fits
 * in `budget`, what is left under the stack's cap after the header, soul and note.
 */
export async function writingVoiceRoomPart(
  input: {
    roomKey: string;
    memberSlug: string;
    /** The member's display name, so its guide reads as its own among the room's. */
    memberName: string;
    chipVoiceId: string | null;
    keptVoiceId: string | null;
    budget: number;
  },
  deps: Deps = {}
): Promise<RoomVoicePart> {
  const none: RoomVoicePart = { text: null, voiceName: null, sentHash: null, log: null };
  let guideId: string | null = null;
  let draftsId: string | null = null;
  let header = ROOM_HEADER;
  let source: TurnVoiceLog['source'] = 'agent';
  for (const [id, from] of [
    [input.chipVoiceId, 'message'],
    [input.keptVoiceId, 'kept'],
  ] as const) {
    if (id && (await readyVoice(id, deps))) {
      guideId = draftsId = id;
      header = MESSAGE_HEADER;
      source = from;
      break;
    }
  }
  if (!guideId) {
    const agent = getStoredAgent(input.memberSlug);
    const chat = agent?.chatRepliesVoiceId ?? null;
    const drafts = agent?.draftsVoiceId ?? null;
    guideId = chat && (await readyVoice(chat, deps)) ? chat : null;
    draftsId = drafts && (await readyVoice(drafts, deps)) ? drafts : null;
  }
  if (!guideId && !draftsId) return none;
  let guide: string | null = null;
  let hashKey: string | null = null;
  let fullGuide = false;
  if (guideId) {
    const body = await styleBody(guideId, deps);
    if (body) {
      hashKey = `${guideId}:${crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
      fullGuide = getRoomVoiceSent(input.roomKey, input.memberSlug) !== hashKey;
      const name = voiceName(guideId) ?? guideId;
      guide = fullGuide
        ? `${roomLabel(input.memberName, name)}\n${header}\n\n${body}`
        : roomReminder(input.memberName, name);
    }
  }
  const result = fit(guide, draftsId ? draftsLine(draftsId) : null, {
    roomKey: input.roomKey,
    agentSlug: input.memberSlug,
    voiceId: guideId,
  }, input.budget);
  if (!result.text) return none;
  return {
    text: result.text,
    voiceName: result.guideSent && guideId ? voiceName(guideId) : null,
    sentHash: result.guideSent && fullGuide ? hashKey : null,
    log: voiceLog(source, guideId, draftsId, result, !fullGuide),
  };
}

