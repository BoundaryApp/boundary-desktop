/**
 * The compact Circle thread from fixture data, for check.mjs. `?theme=light` picks the light
 * palette; the default is dark, as tokens.css has it.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { CircleMessage, CircleSnapshot } from '../../src/shared/types/circles';
import type { CircleChatView } from '../../src/renderer/product/circles/useCircleChat';
import { CircleThread } from '../../src/renderer/product/chat/circle/CircleThread';
import '../../src/index.css';
import 'streamdown/styles.css';
import '../../src/renderer/product/chat/workbench.css';
import '../../src/renderer/product/circles/circles.css';

if (new URLSearchParams(window.location.search).get('theme') === 'light') {
  document.documentElement.dataset.theme = 'light';
}

const ME = 'aa'.repeat(32);
const MAYA = 'bb'.repeat(32);
const SAM = 'dd'.repeat(32);
const AT = Date.UTC(2026, 10, 3, 9, 12);

const circle: CircleSnapshot = {
  key: 'cc'.repeat(32),
  name: 'The Thursday evening book club and allotment society',
  myRole: 'admin',
  members: [
    { identity: ME, name: 'Ada', role: 'admin', isMe: true, online: true },
    { identity: MAYA, name: 'Maya Fernández-Oyelaran', role: 'member', isMe: false, online: true },
  ],
  invites: [],
  offers: [],
  needsUpdate: false,
  writable: true,
};

let seq = 0;
const message = (text: string, extra: Partial<CircleMessage> = {}): CircleMessage => ({
  circleKey: circle.key,
  channel: 'general',
  author: MAYA,
  id: (++seq).toString(16).padStart(16, '0'),
  name: 'Maya Fernández-Oyelaran',
  agent: null,
  text,
  at: AT + seq * 7 * 60_000,
  confirmed: true,
  edited: false,
  deleted: null,
  shared: null,
  call: null,
  mine: false,
  ...extra,
});

const messages = [
  message('Chapter 3 tonight? I put the notes at https://example.com/a/very/long/link/that/does/not/break/anywhere/at/all'),
  message('```\nconst plotsAssignedThisSeasonByGardener = gardeners.map((g) => g.plots.length)\n```'),
  message('Sounds good, see you at 7. Bringing the seed catalogue and the long list.', { author: ME, name: 'Ada', mine: true, edited: true }),
  message('Unbreakablewordthatgoesonandonandonwithoutanyspacesatallforthewholeline'),
  message('', { author: SAM, name: 'Sam', deleted: 'admin' }),
  message('Running late', { author: ME, name: 'Ada', mine: true, confirmed: false }),
  message('Summary of the reading', { shared: { role: 'assistant', model: 'qwen3-30b-a3b-instruct-2507' } }),
];

const chat: CircleChatView = {
  messages,
  loading: false,
  more: true,
  error: null,
  goneCount: 0,
  loadOlder: async () => undefined,
  send: async () => null,
  edit: async () => null,
  remove: async () => null,
  markRead: () => undefined,
  typing: [MAYA],
  seenBy: {},
  notifyTyping: () => undefined,
};

const channels = [
  { id: 'general', name: 'General', unread: 0 },
  { id: 'garden', name: 'Garden plots and the shared shed', unread: 12 },
];

createRoot(document.getElementById('root')!).render(
  <div className="workbench" style={{ display: 'flex', height: '100vh', width: '100vw', background: 'var(--surface-0, var(--bg))' }}>
    <CircleThread
      compact
      circle={circle}
      channel={channels[0]}
      channels={channels}
      onOpenChannel={() => undefined}
      chat={chat}
    />
  </div>
);
