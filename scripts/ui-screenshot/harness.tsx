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
import type {
  AgentProfile,
  ChannelRecord,
  HermesChatMessage,
  HermesChatThreadSummary,
  HermesProjectRecord,
} from '../../src/shared/types/hermesChat';
import { BUILTIN_ASSISTANT_SLUG } from '../../src/shared/types/hermesChat';
import { BUILTIN_AGENT_FALLBACK } from '../../src/shared/hermesAgentIdentity';
import { ProductReadyShell } from '../../src/renderer/product/ProductReadyShell';
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

/** Bridge namespaces whose calls need a real-looking reply; the rest are inert. */
const bridge: Record<string, Record<string, unknown>> = {
  hermesChat: {
    listThreads: ok({ success: true, threads }),
    getHistory: ok({ success: true, sessionId: OPEN_CHAT, messages: history }),
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
    list: ok({ success: true, channels, lastOpened: { kind: 'hermes', id: OPEN_CHAT } }),
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
    getState: ok({
      status: 'stopped',
      displayName: '',
      snapshot: { identity: '', circles: [] },
      providers: {},
      sharing: { models: [], circles: [], paused: false, away: false },
    }),
    foldersOnMac: ok({ success: true, folders: [] }),
  },
  kanban: {
    snapshot: ok({ available: true, tasks: [], checkedAt: Math.round(NOW / 1000) }),
  },
  codingFolders: {
    list: ok({ success: true, managed: true, grants: [] }),
    busy: ok({ busy: false, sessions: [] }),
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

createRoot(document.getElementById('root')!).render(<ProductReadyShell view="chat" onNavigate={() => undefined} />);
