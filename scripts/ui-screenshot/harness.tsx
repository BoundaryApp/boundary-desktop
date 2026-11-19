/**
 * The chat screen as a new visitor would see it, from made-up data, for shoot.mjs. Every name,
 * folder and message below is invented. `?theme=light` picks the light palette.
 *
 * The images are published, so the harness shows only what the public repository ships. The
 * built-in agent takes its name from the app, and nothing here names a private experiment.
 */
import '@fontsource-variable/ibm-plex-sans/wght.css';
import '@fontsource-variable/ibm-plex-sans/wght-italic.css';
import '@fontsource/ibm-plex-serif/latin-400.css';
import '@fontsource/ibm-plex-serif/latin-400-italic.css';
import '@fontsource/ibm-plex-serif/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { AddonCatalogEntry, AddonListing } from '../../src/shared/types/addons';
import type { AssistantStackStatus } from '../../src/shared/types/assistantStack';
import type {
  CircleChannel,
  CircleMessage,
  CircleReaction,
  DirectConversation,
  DirectMessage,
} from '../../src/shared/types/circles';
import type {
  AgentProfile,
  ChannelRecord,
  HermesChatMessage,
  HermesChatThreadSummary,
  HermesProjectRecord,
} from '../../src/shared/types/hermesChat';
import { BUILTIN_ASSISTANT_SLUG } from '../../src/shared/types/hermesChat';
import { BUILTIN_AGENT_FALLBACK } from '../../src/shared/hermesAgentIdentity';
import { circleMember, circleSnapshot, runningCircles } from '../../src/renderer/__tests__/circleFixtures';
import { ProductReadyShell } from '../../src/renderer/product/ProductReadyShell';
import type { ProductDestination } from '../../src/renderer/product/ProductIconRail';
import './harness.css';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';

/** shoot.mjs fixes the page clock to this moment, so relative times read the same each run. */
const NOW = Date.parse('2026-11-09T10:30:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const agoSeconds = (minutes: number) => Math.round((NOW - minutes * 60_000) / 1000);

const agents: AgentProfile[] = [
  { ...BUILTIN_AGENT_FALLBACK, createdAt: ago(60 * 24 * 30) },
  { slug: 'researcher', displayName: 'Researcher', handle: 'Researcher', role: 'Reads widely and cites sources.', builtIn: false, createdAt: ago(60 * 24 * 12) },
  { slug: 'editor', displayName: 'Editor', handle: 'Editor', role: 'Tightens drafts.', builtIn: false, createdAt: ago(60 * 24 * 10) },
];

const project = (id: string, name: string, minutes: number): HermesProjectRecord => ({
  id,
  name,
  slug: id,
  hostPath: `/Users/ada/Documents/${name}`,
  containerPath: `/workspace/${id}`,
  kind: 'host-folder',
  inference: { mode: 'inherit' },
  codingEnabled: true,
  createdAt: ago(minutes),
  updatedAt: ago(minutes),
});
const projects = [project('garden', 'Community Garden', 60 * 24 * 20), project('thesis', 'Thesis', 60 * 24 * 40)];

const OPEN_CHAT = 'chat-rota';
const chat = (id: string, title: string, minutes: number, projectId: string | null): HermesChatThreadSummary => ({
  id,
  title,
  kind: 'hermes',
  agentSlug: BUILTIN_ASSISTANT_SLUG,
  source: 'boundary',
  projectId,
  createdAt: ago(minutes + 30),
  updatedAt: ago(minutes),
});
const threads: HermesChatThreadSummary[] = [
  chat(OPEN_CHAT, 'Plan the watering rota', 4, 'garden'),
  chat('chat-grant', 'Draft the seed grant letter', 90, 'garden'),
  chat('chat-soil', 'Compare soil test results', 60 * 26, 'garden'),
  chat('chat-lit', 'Summarise the reading list', 60 * 50, 'thesis'),
  chat('chat-trip', 'Weekend trip packing list', 60 * 72, null),
  { ...chat('dm-researcher', 'Researcher', 60 * 3, 'garden'), kind: 'dm', agentSlug: 'researcher' },
  { ...chat('dm-editor', 'Editor', 60 * 30, 'garden'), kind: 'dm', agentSlug: 'editor' },
];

const channels: ChannelRecord[] = [
  {
    id: 'ch-volunteers',
    slug: 'volunteers',
    title: 'volunteers',
    sessionId: 'room-volunteers',
    memberSlugs: [BUILTIN_ASSISTANT_SLUG, 'researcher', 'editor'],
    createdAt: ago(60 * 24 * 5),
    updatedAt: ago(60 * 2),
    projectId: 'garden',
  },
];

const QUESTION =
  'Can you set up a watering rota for the garden? Eight volunteers, beds A to D, and nobody should water two days in a row.';
const REPLY = [
  "Here's a two-week rota. Each volunteer waters every fourth day, so nobody has back-to-back shifts, and each bed gets two people a week.",
  '',
  '| Day | Beds A + B | Beds C + D |',
  '| --- | --- | --- |',
  '| Mon | Priya | Tomás |',
  '| Tue | Jun | Amara |',
  '| Wed | Eli | Sofia |',
  '| Thu | Noor | Ben |',
  '',
  'The second week shifts everyone by one row, so the beds rotate too. I saved it to `rota.md` in the project folder.',
  '',
  'Want me to post it in #volunteers?',
].join('\n');
const ROTA_PATH = '/workspace/garden/rota.md';

/**
 * `?scene=demo` opens the chat empty, for shoot.mjs to type QUESTION and send it; the turn
 * below then plays on the page's timers. Otherwise the chat opens with the finished exchange.
 */
const demo = params.get('scene') === 'demo';
(window as unknown as { uiShotQuestion: string }).uiShotQuestion = QUESTION;

const history: HermesChatMessage[] = demo
  ? []
  : [
      { role: 'user', content: QUESTION, timestamp: agoSeconds(6) },
      { role: 'assistant', agentSlug: BUILTIN_ASSISTANT_SLUG, timestamp: agoSeconds(5), toolCount: 1, files: [ROTA_PATH], content: REPLY },
    ];

/**
 * The grant letter chat, for the writing check scene (ADR 0059), which opens it with
 * `?chat=chat-grant`. The draft is written to trip the check's rules; the chat keeps the
 * council letter voice.
 */
const GRANT_CHAT = 'chat-grant';
const GRANT_QUESTION = 'Draft a short letter to the council’s grants committee asking for £1,200 for seeds and tools.';
const GRANT_REPLY = [
  'Dear Grants Committee,',
  '',
  'I am writing to request £1,200 for seeds and tools for the Community Garden’s coming season. The garden is a testament to what neighbours can do together — a vibrant hub nestled between the school and Hill Street.',
  '',
  'Last year, eight volunteers tended four beds and gave 300 kg of vegetables to the food bank. This year we would like to add two beds for the primary school next door, so that children can plant, water and harvest their own crops.',
  '',
  'Green spaces play a pivotal role in fostering wellbeing, connection and resilience. Your support would help us delve deeper into this work and unlock the garden’s full potential.',
  '',
  'Ultimately, together we can grow something truly special for the whole community.',
  '',
  'Ada, for the Community Garden',
].join('\n');
const grantHistory: HermesChatMessage[] = [
  { role: 'user', content: GRANT_QUESTION, timestamp: agoSeconds(92) },
  { role: 'assistant', agentSlug: BUILTIN_ASSISTANT_SLUG, timestamp: agoSeconds(90), content: GRANT_REPLY },
];
const openChat = params.get('chat') === GRANT_CHAT ? GRANT_CHAT : OPEN_CHAT;

/** Listeners the app registers through hermesChat.on*, so the demo turn can call them. */
const listeners = new Map<string, Set<(event: unknown) => void>>();
const listen = (name: string) => (callback: (event: unknown) => void) => {
  const set = listeners.get(name) ?? new Set();
  listeners.set(name, set);
  set.add(callback);
  return () => set.delete(callback);
};
const emit = (name: string, event: object) => {
  for (const callback of listeners.get(name) ?? []) callback(event);
};

/**
 * One turn as Hermes reports it: preparing, a write_file tool call, the reply in small
 * chunks, then the end. Times are in ms from the send.
 */
function playTurn(requestId: string): void {
  const base = { requestId, sessionId: OPEN_CHAT };
  const tool = { ...base, toolId: 'tool-1', name: 'write_file', args: { path: ROTA_PATH }, turn: 1, maxTurns: 30 };
  const steps: Array<[number, () => void]> = [
    [100, () => emit('onChatPhase', { ...base, phase: 'preparing' })],
    [900, () => emit('onChatPhase', { ...base, phase: 'tool', toolName: 'write_file', toolTurn: 1, maxTurns: 30 })],
    [900, () => emit('onChatTool', { ...tool, status: 'running' })],
    [1900, () => emit('onChatTool', { ...tool, status: 'done', summary: 'Wrote rota.md', durationSec: 0.4, paths: [ROTA_PATH] })],
    [2000, () => emit('onChatPhase', { ...base, phase: 'generating' })],
  ];
  // Words with their trailing space, about as fast as a local model streams them.
  const words = REPLY.match(/\S+\s*/g) ?? [];
  words.forEach((word, i) => steps.push([2100 + i * 35, () => emit('onChatChunk', { ...base, delta: word })]));
  const end = 2100 + words.length * 35 + 100;
  steps.push([end, () => emit('onChatPhase', { ...base, phase: 'done' })]);
  steps.push([end, () => emit('onChatEnd', { ...base, finishReason: 'stop' })]);
  for (const [at, step] of steps) setTimeout(step, at);
}

/** An on* subscription that never fires, with its unsubscribe. */
const subscribe = () => () => undefined;
const isSubscription = (key: string | symbol) => typeof key === 'string' && /^on[A-Z]/.test(key);
/** Every other bridge call resolves to null and every on* subscription is a no-op. */
const inert = (): unknown =>
  new Proxy(() => undefined, {
    get: (_target, key) => (isSubscription(key) ? subscribe : inert()),
    apply: () => Promise.resolve(null),
  });
const ok = <T,>(value: T) => () => Promise.resolve(value);

/**
 * A stack that is up, and the add-on store, for the Services scenes (ADR 0059). The add-ons are
 * the real catalogue's names and summaries; the memory, disk and port facts are made up.
 */
const stackPorts = {
  gateway: 8745, apiServer: 8746, dashboard: 8747, webui: 8748, searxng: 8749, lightrag: 8750,
  neo4jHttp: 8751, neo4jBolt: 8752, opencode: 8753, gptResearcher: 8754, n8n: 8755,
  llmProxyAdmin: 8756, twenty: 8757, actual: 8758, bitwarden: 8759, vikunja: 8760,
} as unknown as AssistantStackStatus['ports'];

const stackStatus: AssistantStackStatus = {
  projectName: 'boundary',
  assistantRoot: '/userData/project',
  dataDir: '/userData/project/data',
  overlayPath: null,
  ports: stackPorts,
  isolationMode: 'container',
  apiBaseUrl: 'http://127.0.0.1:8746',
  healthUrl: 'http://127.0.0.1:8746/healthz',
  setupComplete: true,
  ready: true,
  uiServices: [
    { id: 'hermes-webui', title: 'Chat on the web', description: 'The same chats in a browser tab.', portKey: 'webui', path: '/', url: 'http://127.0.0.1:8748/' },
    { id: 'searxng', title: 'Web search', description: 'The search your agents use.', portKey: 'searxng', path: '/', url: 'http://127.0.0.1:8749/' },
    { id: 'gpt-researcher', title: 'Research', description: 'Longer reports with sources.', portKey: 'gptResearcher', path: '/', url: 'http://127.0.0.1:8754/' },
    { id: 'opencode', title: 'Coding', description: 'The coding agent’s own workspace.', portKey: 'opencode', path: '/', url: 'http://127.0.0.1:8753/' },
  ] as AssistantStackStatus['uiServices'],
};

const addonFacts = {
  engineMiB: 12_288,
  usedMiB: 3_200,
  hostMiB: 32_768,
  diskFreeBytes: 180_000_000_000,
  portInUse: false,
  engineResizable: true,
  reservedMiB: 3_000,
};

const fits = (verdict: 'ok' | 'tight') => ({
  verdict,
  memory: verdict,
  disk: 'ok' as const,
  port: 'ok' as const,
  freeMiB: 9_088,
  suggestedEngineMiB: null,
});

const addon = (
  entry: Partial<AddonCatalogEntry> & Pick<AddonCatalogEntry, 'id' | 'name' | 'summary'>,
  installed: boolean,
  verdict: 'ok' | 'tight' = 'ok'
): AddonListing => ({
  entry: {
    version: '1.0.0',
    profile: entry.id,
    flags: [],
    services: [entry.id],
    reserveMiB: 512,
    limitMiB: 768,
    downloadBytes: 300_000_000,
    port: null,
    restartsHermes: false,
    account: null,
    ...entry,
  } as AddonCatalogEntry,
  installed,
  canRemoveData: true,
  leftover: false,
  stopped: false,
  fit: fits(verdict),
  facts: addonFacts,
});

const addons: AddonListing[] = [
  addon({ id: 'twenty', name: 'Twenty CRM', summary: 'Contacts, companies and deals that your agents can look up and keep current.', reserveMiB: 2208 }, false, 'tight'),
  addon({ id: 'actual', name: 'Actual Budget', summary: 'Your budgets and accounts, so an agent can answer where the money went.', reserveMiB: 640 }, true),
  addon({ id: 'email', name: 'Email', summary: 'Read and draft mail from an account you connect.', reserveMiB: 512 }, true),
  addon({ id: 'vikunja', name: 'Todo lists', summary: 'Lists and tasks an agent can add to, tick off and look back over.', reserveMiB: 512 }, false),
  addon({ id: 'n8n', name: 'Automations', summary: 'Flows that run on a schedule or when something happens.', reserveMiB: 768 }, false),
  addon({ id: 'lightrag', name: 'Knowledge base', summary: 'A searchable index of the documents you point it at.', reserveMiB: 1024 }, false),
];

/** Two calibrated writing voices, for the Settings scene (ADR 0056). Both are invented. */
const writingVoices = [
  {
    id: 'plain-notes',
    name: 'Plain notes',
    status: 'ready' as const,
    pieces: 9,
    words: 4_200,
    createdAt: ago(60 * 24 * 9),
    calibratedAt: ago(60 * 24 * 2),
    sampleHash: 'a1b2c3',
    style: {
      description:
        'Short sentences, no throat-clearing, and the point in the first line. Lists only where the items are genuinely parallel.',
      neverDoes: ['Opens with “Just wanted to…”', 'Uses “leverage” or “utilise”', 'Ends with a summary of what was said'],
      exemplars: ['samples/rota-note.md', 'samples/handover.md'],
      chars: 1_840,
      calibrated: '2026-11-11',
    },
    samplesChanged: false,
    step: null,
  },
  {
    id: 'letter',
    name: 'Letter to the council',
    status: 'ready' as const,
    pieces: 4,
    words: 2_100,
    createdAt: ago(60 * 24 * 4),
    calibratedAt: ago(60 * 24),
    sampleHash: 'd4e5f6',
    style: {
      description: 'Formal but not stiff: full sentences, one ask per paragraph, and a clear date and reference at the top.',
      neverDoes: ['Uses contractions', 'Asks for more than one thing at a time'],
      exemplars: ['samples/allotment-letter.md'],
      chars: 1_210,
      calibrated: '2026-11-12',
    },
    samplesChanged: false,
    step: null,
  },
];

/**
 * A running Circle with a busy General channel, for the Circle chat scenes (ADR 0059). Members,
 * keys and messages are invented. Format 3, so mentions and replies show.
 */
const ME = 'a'.repeat(64);
const PRIYA = 'b'.repeat(64);
const TOMAS = 'd'.repeat(64);
const JUN = 'e'.repeat(64);
const CIRCLE = 'c'.repeat(64);
const memberNames: Record<string, string> = { [ME]: 'Ada', [PRIYA]: 'Priya', [TOMAS]: 'Tomás', [JUN]: 'Jun' };

const circleState = runningCircles({
  identity: ME,
  circles: [
    circleSnapshot({
      key: CIRCLE,
      name: 'Garden club',
      format: 3,
      members: [
        circleMember({ identity: ME, name: 'Ada', isMe: true, role: 'admin' }),
        circleMember({ identity: PRIYA, name: 'Priya', role: 'admin' }),
        circleMember({ identity: TOMAS, name: 'Tomás' }),
        circleMember({ identity: JUN, name: 'Jun', online: false }),
      ],
    }),
    circleSnapshot({ key: 'f'.repeat(64), name: 'Neighbours', format: 3 }),
  ],
});

const circleChannels: CircleChannel[] = [
  { id: 'general', name: 'General', unread: 0, mentioned: false },
  { id: 'planting', name: 'Planting', unread: 3, mentioned: true },
  { id: 'tools', name: 'Tool shed', unread: 1, mentioned: false },
];

const reaction = (emoji: string, who: string[]): CircleReaction => ({
  emoji,
  count: who.length,
  mine: who[0] === ME,
  people: who.map((identity, i) => ({ identity, name: memberNames[identity], left: false, at: NOW - (40 - i) * 60_000 })),
});

let messageId = 0;
const circleMessage = (author: string, minutes: number, text: string, extra: Partial<CircleMessage> = {}): CircleMessage => ({
  circleKey: CIRCLE,
  channel: 'general',
  author,
  id: `m${(messageId += 1)}`,
  name: memberNames[author],
  agent: null,
  text,
  at: NOW - minutes * 60_000,
  confirmed: true,
  edited: false,
  deleted: null,
  shared: null,
  call: null,
  mentions: null,
  reply: null,
  reactions: [],
  mine: author === ME,
  ...extra,
});

const generalMessages: CircleMessage[] = [
  circleMessage(PRIYA, 95, 'The seedlings arrived this morning: tomatoes, chard and two trays of beans.', {
    reactions: [reaction('🌱', [ME, TOMAS, JUN]), reaction('🙌', [TOMAS, PRIYA])],
  }),
  circleMessage(TOMAS, 80, 'I can plant on Saturday morning. @Ada, are you bringing the trowels?', {
    mentions: { members: [ME], channel: false },
  }),
  circleMessage(ME, 74, 'Yes, all six. I’ll leave them by the shed on Friday night.', {
    reactions: [reaction('👍', [TOMAS, PRIYA])],
  }),
  circleMessage(PRIYA, 30, '@channel the tap is off until noon on Saturday, so fill the cans on Friday.', {
    mentions: { members: [], channel: true },
    reactions: [reaction('👀', [JUN]), reaction('🙏', [ME, TOMAS])],
  }),
  circleMessage(JUN, 12, 'I’ll bring the long hose for bed D, then.'),
];

const directConversations: DirectConversation[] = [
  { peer: PRIYA, name: 'Priya', online: true, ended: false, last: { at: NOW - 6 * 60_000, text: 'Perfect, see you then.', mine: false, deleted: false }, waiting: 0, unread: 0 },
  { peer: JUN, name: 'Jun', online: false, ended: false, last: { at: NOW - 60 * 60_000, text: 'Thanks!', mine: false, deleted: false }, waiting: 0, unread: 1 },
];

const direct = (author: string, minutes: number, text: string, id: string): DirectMessage => ({
  id,
  author,
  mine: author === ME,
  text,
  at: NOW - minutes * 60_000,
  reply: null,
  edited: false,
  deleted: false,
  delivery: author === ME ? 'delivered' : null,
  neverSent: false,
});

const directMessages: DirectMessage[] = [
  direct(PRIYA, 22, 'Could you keep the shed key this week? I’m away from Sunday.', 'd1'),
  direct(ME, 18, 'Of course. Shall I pick it up after planting?', 'd2'),
  direct(PRIYA, 9, 'That works. It’s on the blue fob, with the padlock key.', 'd3'),
  direct(ME, 7, 'Got it. I’ll put it back on the hook when you’re home.', 'd4'),
  direct(PRIYA, 6, 'Perfect, see you then.', 'd5'),
];

/**
 * Only the Circles destination sees the Circle running, so the published chat screenshots keep
 * a rail without Circle unread counts.
 */
const circlesShown = params.get('view') === 'circles';
const stoppedCircles = {
  status: 'stopped',
  displayName: '',
  snapshot: { identity: '', circles: [] },
  providers: {},
  sharing: { models: [], circles: [], paused: false, away: false },
};

const withState = <T extends object>(value: T) => () => Promise.resolve({ success: true, state: circleState, ...value });

/** Bridge namespaces whose calls need a real-looking reply; the rest are inert. */
const bridge: Record<string, Record<string, unknown>> = {
  hermesChat: {
    listThreads: ok({ success: true, threads }),
    getHistory: ({ sessionId }: { sessionId: string }) =>
      Promise.resolve(
        sessionId === GRANT_CHAT
          ? { success: true, sessionId: GRANT_CHAT, messages: grantHistory }
          : { success: true, sessionId: OPEN_CHAT, messages: history }
      ),
    listMentions: ok({ success: true, mentions: [] }),
    listProjectMarks: ok([]),
    getSessionInference: ok({
      resolved: { slot: 'local', modelId: 'qwen3:14b', providerDisplayName: 'Local', provenance: 'app-default', configured: true, health: 'reachable', needsRestart: false },
      marks: [],
    }),
    listPendingApprovals: ok([]),
    listPendingCredentialRequests: ok([]),
    getContextBreakdown: ok({ success: false }),
    startChat: (payload: { requestId: string }) => {
      playTurn(payload.requestId);
      return Promise.resolve({ success: true, requestId: payload.requestId, sessionId: OPEN_CHAT, storedSessionId: OPEN_CHAT });
    },
    onChatPhase: listen('onChatPhase'),
    onChatTool: listen('onChatTool'),
    onChatChunk: listen('onChatChunk'),
    onChatEnd: listen('onChatEnd'),
  },
  agents: {
    list: ok({ success: true, agents, standingDmByAgent: { [BUILTIN_ASSISTANT_SLUG]: null, researcher: 'dm-researcher', editor: 'dm-editor' } }),
  },
  channels: {
    list: ok({ success: true, channels, lastOpened: { kind: 'hermes', id: openChat } }),
  },
  projects: {
    list: ok({ success: true, projects, activeId: 'garden', rpcAvailable: true }),
    inspectSources: ok({
      success: true,
      inspect: {
        projectId: 'garden',
        stale: false,
        sources: [
          { id: 'hub', path: '/workspace/garden', hostPath: '/Users/ada/Documents/Community Garden', retrieval: 'files', visibility: 'hub', isHub: true },
        ],
      },
    }),
  },
  circles: {
    getState: ok(circlesShown ? circleState : stoppedCircles),
    // Only Garden club has a chat; the other Circle is quiet.
    chatChannels: ({ key }: { key: string }) =>
      withState({ channels: key === CIRCLE ? circleChannels : [{ id: 'general', name: 'General', unread: 0, mentioned: false }] })(),
    chatMessages: ({ key, channel }: { key: string; channel: string }) =>
      withState({ messages: key === CIRCLE && channel === 'general' ? generalMessages : [], more: false })(),
    dmList: ({ key }: { key: string }) => withState({ conversations: key === CIRCLE ? directConversations : [] })(),
    dmMessages: ({ key, peer }: { key: string; peer: string }) =>
      withState({ messages: key === CIRCLE && peer === PRIYA ? directMessages : [], more: false })(),
    foldersList: withState({ folders: [] }),
    notifyPrefs: ok({ prefs: { level: 'default', channelMentions: true }, resolved: 'all', people: 4, global: { enabled: true, showText: true } }),
    foldersOnMac: ok({ success: true, folders: [] }),
  },
  kanban: {
    snapshot: ok({ available: true, tasks: [], checkedAt: Math.round(NOW / 1000) }),
  },
  codingFolders: {
    list: ok({ success: true, managed: true, grants: [] }),
    busy: ok({ busy: false, sessions: [] }),
  },
  assistantStack: {
    getStatus: ok(stackStatus),
    getLifecycle: ok({ phase: 'ready', services: [], startedAt: NOW, message: null }),
    ensureRunning: ok({ success: true, status: stackStatus }),
    getWebSearchMode: ok({ mode: 'gate', available: true }),
  },
  addons: {
    list: ok(addons),
    snapshot: ok(null),
    runningWork: ok([]),
    pending: ok([]),
    twentyWorkspaces: ok({ success: true, workspaces: [] }),
    actualOverview: ok(null),
    bitwardenOverview: ok(null),
    emailOverview: ok(null),
  },
  // Release notes (ADR 0059): a launch that upgraded, with nothing read yet.
  whatsNew: {
    getState: ok({
      currentVersion: '0.0.1-rc.12',
      upgradedFrom: '0.0.1-rc.11',
      firstInstall: false,
      seen: [],
      popups: true,
    }),
    markSeen: ok(undefined),
    setPopups: ok(undefined),
  },
  // The composer asks for the chat's writing voice as it mounts; an unanswered call resolves to
  // null, which the caller reads as a result object (ADR 0056 §6).
  writingVoices: {
    list: ok({ success: true, voices: writingVoices }),
    getChat: (sessionId: string) =>
      Promise.resolve(
        sessionId === GRANT_CHAT
          ? { success: true, voice: { voiceId: 'letter', voiceName: 'Letter to the council', marks: [] } }
          : { success: false, error: 'none kept' }
      ),
    samples: ok({ success: true, samples: [] }),
    users: ok({ success: true, users: [] }),
  },
  // The Check pane asks whether a detector add-on answers; none does here.
  writingCheck: {
    detectorStatus: ok({ available: false }),
  },
  onboarding: {
    probeSlotHealth: ok({ health: 'reachable' }),
    getStatus: ok({
      configured: true,
      encryptionAvailable: true,
      appDefault: 'local',
      slots: { local: { configured: true, modelId: 'qwen3:14b', health: 'reachable' } },
    }),
  },
};
(window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(
  {},
  {
    get: (_target, key) => {
      const known = typeof key === 'string' ? bridge[key] : undefined;
      if (!known) return inert();
      // A stubbed namespace answers its own calls; anything else it is asked falls back to inert.
      return new Proxy(known, {
        get: (target, name) => {
          if (typeof name === 'string' && name in target) return target[name];
          return isSubscription(name) ? subscribe : inert();
        },
      });
    },
  }
);

/** `?view=` opens a destination, for the release notes scenes (ADR 0059). */
const Harness: React.FC = () => {
  const [view, setView] = React.useState<ProductDestination>(
    (params.get('view') as ProductDestination | null) ?? 'chat'
  );
  return <ProductReadyShell view={view} onNavigate={setView} />;
};

createRoot(document.getElementById('root')!).render(<Harness />);
