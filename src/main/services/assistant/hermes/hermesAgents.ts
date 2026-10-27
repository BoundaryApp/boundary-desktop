import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import type {
  AgentProfile,
  HermesAgentCreatePayload,
  HermesAgentCreateResult,
  HermesAgentsListResult,
  HermesAgentSoulPayload,
  HermesAgentUpdatePayload,
  HermesAgentUpdateResult,
  HermesAgentSoulResult,
  HermesChatThreadSummary,
} from '../../../../shared/types/hermesChat';
import {
  agentSlugFromDisplayName,
  BUILTIN_ASSISTANT_SLUG,
} from '../../../../shared/types/hermesChat';
import {
  builtinAgentName,
  clashesWithBuiltinAgent,
} from '../../../../shared/hermesAgentIdentity';
import { uniqueSlug } from '../../../../shared/utils/slug';
import { newestFirst } from '../../../../shared/utils/sort';
import { resolveActiveAssistantDataRoot } from '../resolveAssistantRoot';
import { excerptSoul, readSoulFile, resolveSoulFilePath, rewriteSoulIdentity } from './agentSoul';
import { getHermesGatewaySession } from './hermesGatewaySession';
import {
  getSessionAgentSlug,
  getSessionChannelId,
  getStandingDmMap,
  getStandingDmSessionId,
  getStoredAgent,
  listStoredAgents,
  setSessionAgentSlug,
  setSessionChannelId,
  upsertStoredAgent,
  getChannelBySessionId,
  getStoredChannel,
  listStoredChannels,
} from './hermesAgentStore';

const RESERVED_SLUGS = new Set([
  BUILTIN_ASSISTANT_SLUG,
  'hermes',
  'browser',
  'api-server',
  'default',
]);

function registryPath(): string {
  return path.join(resolveActiveAssistantDataRoot(), 'hermes', 'agents', 'registry.json');
}

function readRegistryAgents(): AgentProfile[] {
  try {
    const file = registryPath();
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      agents?: Array<{
        name?: string;
        display_name?: string;
        role?: string;
        created_at?: string;
      }>;
    };
    const rows = Array.isArray(raw.agents) ? raw.agents : [];
    return rows
      .filter((a) => typeof a?.name === 'string' && a.name.trim())
      .map((a) => {
        const slug = a.name!.trim();
        const displayName = (a.display_name ?? slug).trim() || slug;
        return {
          slug,
          displayName,
          handle: displayName,
          role: (a.role ?? '').trim() || 'Specialist on this machine.',
          builtIn: false,
          createdAt: a.created_at ?? new Date().toISOString(),
        } satisfies AgentProfile;
      })
      .filter((a) => !RESERVED_SLUGS.has(a.slug) || a.slug === BUILTIN_ASSISTANT_SLUG);
  } catch {
    return [];
  }
}

function upsertRegistry(agent: AgentProfile): void {
  try {
    const file = registryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let data: { agents: Array<Record<string, unknown>> } = { agents: [] };
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          agents?: Array<Record<string, unknown>>;
        };
        if (Array.isArray(parsed.agents)) {
          data = { agents: parsed.agents };
        }
      } catch {
        data = { agents: [] };
      }
    }
    const idx = data.agents.findIndex((a) => a.name === agent.slug);
    const row = {
      name: agent.slug,
      display_name: agent.displayName,
      role: agent.role,
      created_at: agent.createdAt,
      transports: {},
    };
    if (idx >= 0) {
      data.agents[idx] = { ...data.agents[idx], ...row };
    } else {
      data.agents.push(row);
    }
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch {
    /* registry is best-effort — electron-store is source of truth for UI */
  }
}

function mergeAgents(): AgentProfile[] {
  const stored = listStoredAgents();
  const bySlug = new Map(stored.map((a) => [a.slug, a]));
  for (const reg of readRegistryAgents()) {
    if (!bySlug.has(reg.slug)) {
      bySlug.set(reg.slug, reg);
      upsertStoredAgent(reg);
    }
  }
  const builtin = bySlug.get(BUILTIN_ASSISTANT_SLUG)!;
  const rest = [...bySlug.values()]
    .filter((a) => a.slug !== BUILTIN_ASSISTANT_SLUG)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return [builtin, ...rest];
}

export function listHermesAgents(): HermesAgentsListResult {
  try {
    return {
      success: true,
      agents: mergeAgents(),
      standingDmByAgent: getStandingDmMap(),
    };
  } catch (err) {
    return {
      success: false,
      agents: listStoredAgents(),
      standingDmByAgent: getStandingDmMap(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function uniqueAgentSlug(base: string): string {
  return uniqueSlug(base, [...mergeAgents().map((a) => a.slug), ...RESERVED_SLUGS]);
}

function soulForRole(displayName: string, role: string): string {
  return [
    `# ${displayName}`,
    '',
    role.trim() || 'Focus on your specialty; collaborate via project files and shared rooms.',
    '',
    '## Memory',
    '- Private: your memories/ and session search. Siblings do not read them.',
    '- Project: the bound host folder. Shared with every agent who can see it.',
    '- Global: /opt/memory when mounted.',
    '',
    'Room posts without @ are for later reading. Do not reply in a channel unless you are @mentioned or added and addressed.',
    '',
    '## Signing in to websites',
    '- Call browser_vault_list. If it has a login for the site, open the sign-in page, type the username, then call browser_vault_fill.',
    '- If it has none, open the site’s sign-in page first, then call browser_vault_save_login. The owner gets a form for it; do not ask for the login in chat.',
    '- Never type or ask for a password yourself.',
    '',
    '## Calendars',
    '- If you can read a calendar but have no tool to add, move or delete events, say you can only read it, and that the owner can give you Read and change in Boundary under Settings → Calendars. Never say you changed an event you could not change.',
    '',
    'When the owner asks you to draft a new specialist agent, reply with a fenced',
    'agent-draft block and nothing else required for the card:',
    '```agent-draft',
    'displayName: Example Name',
    'handle: example-name',
    'role: One paragraph of standing instructions.',
    '```',
    'Nothing is live until the owner confirms Create. Do not invent profiles on your own.',
  ].join('\n');
}

/** Both ids name the same Hermes session (the gateway knows a runtime and a stored id). */
function sameSession(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const gateway = getHermesGatewaySession();
    return gateway.storedSessionId(a) === gateway.storedSessionId(b);
  } catch {
    return false;
  }
}

/** The id to keep in Boundary's records: the stored id when the gateway knows it. */
export function durableSessionId(sessionId: string): string {
  try {
    return getHermesGatewaySession().storedSessionId(sessionId);
  } catch {
    return sessionId;
  }
}

/**
 * Tokens of history a DM sends each reply (ADR 0023 §7, CR 0002 R1). The stack trims or
 * summarises anything older; side chats and Hermes chats have no budget.
 */
export const DM_HISTORY_BUDGET = 8_000;

/** The budget to send when creating or resuming this session: DMs only. */
export function historyBudgetFor(sessionId: string): number | undefined {
  const slug = getSessionAgentSlug(sessionId);
  if (!slug) return undefined;
  return conversationKindFor(sessionId, slug) === 'dm' ? DM_HISTORY_BUDGET : undefined;
}

/** Kind of a non-channel session from its owner and the standing DM map (ADR 0023). */
export function conversationKindFor(
  sessionId: string,
  agentSlug: string,
  standing: Record<string, string | null> = getStandingDmMap()
): 'hermes' | 'dm' | 'side' {
  if (agentSlug === BUILTIN_ASSISTANT_SLUG) return 'hermes';
  return sameSession(standing[agentSlug], sessionId) ? 'dm' : 'side';
}

/**
 * Annotate gateway/local threads with their owner and kind (ADR 0023).
 * Unmarked non-channel sessions (including Telegram, CLI and WebUI ones) are claimed for
 * the built-in agent and become Hermes chats. A personality's standing session is its DM;
 * any other session it owns is a side chat. Channels are always channels.
 */
export function annotateThreadsWithAgents(
  threads: HermesChatThreadSummary[]
): HermesChatThreadSummary[] {
  const standing = getStandingDmMap();
  const channelsBySession = new Map(
    listStoredChannels().map((c) => [c.sessionId, c] as const)
  );
  const sorted = [...threads].sort(newestFirst);

  // Claim unmarked non-channel sessions for the built-in agent.
  for (const thread of sorted) {
    const channelId =
      getSessionChannelId(thread.id) ??
      channelsBySession.get(thread.id)?.id ??
      null;
    if (channelId) {
      if (!getSessionChannelId(thread.id)) {
        const ch = getStoredChannel(channelId) ?? channelsBySession.get(thread.id);
        if (ch) setSessionChannelId(thread.id, ch.id);
      }
      continue;
    }
    if (!getSessionAgentSlug(thread.id)) {
      setSessionAgentSlug(thread.id, BUILTIN_ASSISTANT_SLUG);
    }
  }

  return sorted.map((thread) => {
    const channel =
      getChannelBySessionId(thread.id) ??
      (() => {
        const cid = getSessionChannelId(thread.id);
        return cid ? getStoredChannel(cid) : null;
      })();
    if (channel) {
      return {
        ...thread,
        agentSlug: BUILTIN_ASSISTANT_SLUG,
        kind: 'channel' as const,
        channelId: channel.id,
        channelSlug: channel.slug,
        // The room's own name, so a rename shows even before Hermes retitles its session.
        title: `#${channel.slug}`,
      };
    }
    const agentSlug = getSessionAgentSlug(thread.id) ?? BUILTIN_ASSISTANT_SLUG;
    return {
      ...thread,
      agentSlug,
      kind: conversationKindFor(thread.id, agentSlug, standing),
    };
  });
}

/** The trimmed name, role and handle of a new or edited agent, or why they are refused. */
function agentFields(payload: {
  displayName: string;
  role: string;
  handle?: string;
}): { displayName: string; role: string; handle: string } | { error: string } {
  const displayName = payload.displayName.trim();
  const role = payload.role.trim();
  if (!displayName) return { error: 'Display name is required.' };
  if (!role) return { error: 'Role is required.' };
  const handle = (payload.handle?.trim() || displayName).replace(/^@/, '');
  const agents = listStoredAgents();
  if (clashesWithBuiltinAgent(displayName, agents) || clashesWithBuiltinAgent(handle, agents)) {
    return { error: `“${builtinAgentName(agents)}” is the built-in agent's name. Pick another.` };
  }
  return { displayName, role, handle };
}

export async function createHermesAgent(
  payload: HermesAgentCreatePayload
): Promise<HermesAgentCreateResult> {
  const fields = agentFields(payload);
  if ('error' in fields) return { success: false, error: fields.error };
  const { displayName, role, handle } = fields;
  const baseSlug = agentSlugFromDisplayName(
    payload.handle?.trim() ? payload.handle.replace(/^@/, '') : displayName
  );
  if (RESERVED_SLUGS.has(baseSlug) && baseSlug !== BUILTIN_ASSISTANT_SLUG) {
    return { success: false, error: `Name “${baseSlug}” is reserved.` };
  }
  const slug = uniqueAgentSlug(baseSlug);

  const agent: AgentProfile = {
    slug,
    displayName,
    handle,
    role,
    builtIn: false,
    createdAt: new Date().toISOString(),
  };

  let starting = true;
  try {
    const gateway = getHermesGatewaySession();
    await gateway.ensureConnected();
    await gateway.createProfile({
      name: slug,
      description: role,
      soul: soulForRole(displayName, role),
      mirrorCredentials: true,
    });
  } catch (err) {
    // Still register in UI — profile may already exist or gateway may lag.
    const message = err instanceof Error ? err.message : String(err);
    if (!/already|exists/i.test(message)) {
      // Keep going: electron-store + registry still let the human DM;
      // turns will attempt profile routing and surface errors if needed.
      starting = true;
    }
  }

  upsertStoredAgent(agent);
  upsertRegistry(agent);

  // The stack's bootstrap never sees this profile, so it has no model limits or MCP servers
  // (OpenCode and the rest) unless Boundary writes them. Imported lazily: the stack service is heavy.
  void import('../AssistantStackService')
    .then(({ setUpNewHermesProfile }) => setUpNewHermesProfile(slug))
    .catch((err) => {
      console.warn(
        '[hermesAgents] new profile setup not written',
        slug,
        err instanceof Error ? err.message : err
      );
    });

  // No DM yet: the first message sent to the agent starts it and claims it (claimNewSession).
  // An empty session made now would not be stored by Hermes, so it could not be resumed later.
  return { success: true, agent, starting };
}

/**
 * Edit a personality's name, handle and role (ADR 0010 §4). The slug is its Hermes profile, so
 * it stays. A new role (or name) goes into the profile's description and SOUL.md, unless the
 * soul was edited by hand. The built-in agent's name comes from the stack, so it isn't
 * editable here.
 */
export async function updateHermesAgent(
  payload: HermesAgentUpdatePayload
): Promise<HermesAgentUpdateResult> {
  const agent = getStoredAgent(payload.slug?.trim() ?? '');
  if (!agent) {
    return { success: false, error: 'Unknown agent.' };
  }
  if (agent.builtIn || agent.slug === BUILTIN_ASSISTANT_SLUG) {
    return { success: false, error: 'The built-in agent can’t be edited.' };
  }
  const fields = agentFields(payload);
  if ('error' in fields) return { success: false, error: fields.error };
  const { displayName, role, handle } = fields;

  const next: AgentProfile = { ...agent, displayName, handle, role };
  const renamed = displayName !== agent.displayName;
  const roleChanged = role !== agent.role.trim();
  if (!renamed && !roleChanged && handle === agent.handle) {
    return { success: true, agent };
  }

  let soulKept = false;
  let error: string | undefined;
  if (renamed || roleChanged) {
    try {
      const gateway = getHermesGatewaySession();
      const current =
        readSoulFile(resolveSoulFilePath(resolveActiveAssistantDataRoot(), agent.slug)) ??
        (await gateway.describeProfile(agent.slug)).soul ??
        null;
      const soul = current ? rewriteSoulIdentity(current, agent, next) : null;
      soulKept = soul === null;
      const sections = {
        ...(roleChanged ? { description: role } : {}),
        ...(soul !== null ? { soul } : {}),
      };
      if (Object.keys(sections).length > 0) {
        const { ok } = await gateway.configureProfile(agent.slug, sections);
        if (!ok) error = 'Saved, but Hermes didn’t take all of the change. Try again.';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error = `Saved, but Hermes didn’t take the change: ${message}`;
    }
  }

  upsertStoredAgent(next);
  upsertRegistry(next);

  const dm = renamed ? getStandingDmSessionId(agent.slug) : null;
  if (dm) {
    try {
      await getHermesGatewaySession().setSessionTitle(dm, `DM · ${displayName}`);
    } catch {
      // The rail names DMs after the agent; only Hermes's own list keeps the old title.
    }
  }

  return {
    success: true,
    agent: next,
    ...(soulKept ? { soulKept } : {}),
    ...(error ? { error } : {}),
  };
}

export function resolveProfileForAgent(agentSlug: string | null | undefined): string | null {
  if (!agentSlug || agentSlug === BUILTIN_ASSISTANT_SLUG) return null;
  return agentSlug;
}

export async function getHermesAgentSoul(
  payload: HermesAgentSoulPayload
): Promise<HermesAgentSoulResult> {
  const slug = payload.slug.trim();
  const agent = getStoredAgent(slug);
  if (!agent) {
    return { success: false, error: 'Unknown agent.' };
  }

  const filePath = resolveSoulFilePath(resolveActiveAssistantDataRoot(), slug);
  const fileSoul = readSoulFile(filePath);
  let described: string | null;
  try {
    const snapshot = await getHermesGatewaySession().describeProfile(
      agent.builtIn ? '' : slug
    );
    described = snapshot.soul?.trim() ? snapshot.soul : null;
  } catch {
    described = null;
  }

  if (agent.builtIn && !described && !fileSoul) {
    return { success: true, excerpt: null, canOpen: false };
  }

  const raw = described ?? fileSoul;
  const excerpt = raw ? excerptSoul(raw) || null : null;
  return {
    success: true,
    excerpt,
    canOpen: Boolean(fileSoul),
  };
}

/**
 * The SOUL.md of an agent Boundary created, from its profile folder, or null for the built-in
 * agent (its soul is the default profile's system prompt) and for a missing or empty file.
 */
export function readAgentSoul(slug: string): string | null {
  const agent = getStoredAgent(slug);
  if (!agent || agent.builtIn) return null;
  const soul = readSoulFile(resolveSoulFilePath(resolveActiveAssistantDataRoot(), slug))?.trim();
  return soul || null;
}

export function revealHermesAgentSoul(
  payload: HermesAgentSoulPayload
): { success: boolean; error?: string } {
  const slug = payload.slug.trim();
  const filePath = resolveSoulFilePath(resolveActiveAssistantDataRoot(), slug);
  if (!fs.existsSync(filePath)) {
    return { success: false, error: 'SOUL.md is not on this machine.' };
  }
  shell.showItemInFolder(filePath);
  return { success: true };
}
