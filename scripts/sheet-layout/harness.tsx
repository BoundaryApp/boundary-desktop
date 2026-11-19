/**
 * Sheets and panels from fixture data, for check.mjs. `?view=` picks one of VIEWS (the Updates
 * panel in the Settings sheet, a Circle form sheet, or the Circle inspector tab); `?state=` picks an Updates state from STATES;
 * `?theme=light` picks the light palette.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { UpdateSnapshot } from '../../src/shared/types/updates';
import { SettingsSheet } from '../../src/renderer/product/SettingsSheet';
import { StartJoinSheets } from '../../src/renderer/product/chat/circle/StartJoinSheets';
import { ChannelSheets } from '../../src/renderer/product/chat/circle/ChannelSheets';
import { CircleTab } from '../../src/renderer/product/chat/circle/CircleTab';
import { CallCheckSheet } from '../../src/renderer/product/chat/circle/CallCheckSheet';
import type { CallCheck } from '../../src/renderer/product/circles/callCheck';
import type { CallCheckResult } from '../../src/shared/callCheck';
import { ProjectSourcesRail } from '../../src/renderer/product/chat/ProjectSourcesRail';
import type { HermesProjectRecord } from '../../src/shared/types/hermesChat';
import { Callout, RetryCallout } from '../../src/renderer/components/ui/alert';
import { Button } from '../../src/renderer/components/ui/button';
import type { CircleSnapshot, CirclesState } from '../../src/shared/types/circles';
import './harness.css';
import '../../src/renderer/product/chat/workbench.css';

const params = new URLSearchParams(window.location.search);
if (params.get('theme') === 'light') document.documentElement.dataset.theme = 'light';

const base: UpdateSnapshot = {
  currentVersion: '0.0.1-rc.7',
  channel: 'beta',
  checksEnabled: true,
  blocked: 'none',
  phase: 'idle',
  version: null,
  summary: [],
  size: null,
  downloadPercent: null,
  stackChanges: false,
  checking: false,
  lastCheckedAt: '2026-11-07T11:38:00Z',
  error: null,
  keyRequired: true,
  showCard: false,
  waiting: [],
  restartIn: null,
  restarting: false,
  updated: { version: '0.0.1-rc.7', summary: ['First build with in-app updates.'] },
  showUpdated: false,
};

/** check.mjs names these in its STATES list. */
const STATES: Record<string, UpdateSnapshot> = {
  'up-to-date': base,
  available: { ...base, phase: 'available', version: '0.0.1-rc.8', size: 312e6, summary: ['Calls between Macs.', 'A spacing check for the stylesheets.'], keyRequired: false },
  waiting: {
    ...base,
    phase: 'ready',
    version: '0.0.1-rc.8',
    waiting: [
      { id: 'a', kind: 'chat', title: 'Plan the allotment rota', detail: 'Replying', finished: false },
      { id: 'b', kind: 'coding', title: 'Fix the calendar sync', detail: 'Running tests', finished: true },
    ],
  },
  blocked: { ...base, blocked: 'not-in-applications', keyRequired: false, updated: null },
};

const state = STATES[params.get('state') ?? 'up-to-date'] ?? base;

/** Every other bridge call resolves to null and every on* subscription is a no-op. */
const inert = (): unknown =>
  new Proxy(() => undefined, {
    get: (_target, key) => (typeof key === 'string' && key.startsWith('on') ? () => () => undefined : inert()),
    apply: () => Promise.resolve(null),
  });
const updates = {
  getState: () => Promise.resolve(state),
  onState: () => () => undefined,
  closeCard: () => Promise.resolve(),
};
/** Bridge namespaces whose calls need a real-looking reply; the rest are inert. */
const bridge: Record<string, unknown> = {
  updates,
  codingFolders: {
    list: () => Promise.resolve({ success: true, managed: true, grants: [] }),
    busy: () => Promise.resolve({ busy: false, sessions: [] }),
    onProgress: () => () => undefined,
  },
  hostBridge: {
    listGrants: () =>
      Promise.resolve([
        { capability: 'open_url', resource: 'https://example.com', createdAt: '2026-11-01T09:00:00Z', expiresAt: null },
        { capability: 'read_file', resource: '/Users/ada/Documents/Job Search/notes.md', createdAt: '2026-11-02T09:00:00Z', expiresAt: '2026-12-02T09:00:00Z' },
      ]),
    agentStopped: () => Promise.resolve({ stopped: false }),
    getBrowserState: () =>
      Promise.resolve({
        settings: { enabled: true, blocked: null, allowed: [] },
        effectiveBlocked: ['bank.example.com', 'pay.example.com'],
        defaultBlocked: ['bank.example.com', 'pay.example.com'],
        chromeInstalled: true,
        running: false,
        clients: 0,
      }),
  },
  assistantStack: {
    getWebSearchMode: () => Promise.resolve({ mode: 'private', available: true, canChange: true, overrides: [] }),
  },
  onboarding: {
    getStatus: () =>
      Promise.resolve({
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
      const known = typeof key === 'string' ? (bridge[key] as Record<string, unknown> | undefined) : undefined;
      if (!known) return inert();
      // A stubbed namespace answers its own calls; anything else it is asked falls back to inert.
      return new Proxy(known, { get: (target, name) => (typeof name === 'string' && name in target ? target[name] : inert()) });
    },
  }
);

const none = () => undefined;

const circle: CircleSnapshot = {
  key: 'cc'.repeat(32),
  name: 'Main Admin 2',
  myRole: 'admin',
  members: [
    { identity: 'aa'.repeat(32), name: 'Sam', role: 'admin', isMe: true, online: true },
    { identity: 'bb'.repeat(32), name: 'external', role: 'member', isMe: false, online: true },
  ],
  invites: [],
  offers: [],
  needsUpdate: false,
  writable: true,
};
const circles = { status: 'running', displayName: 'Sam', snapshot: { identity: 'aa'.repeat(32), circles: [circle] } } as unknown as CirclesState;
const MODES = ['host', 'stun', 'swarm', 'tunnel', 'stun+tunnel'] as const;
const results: CallCheckResult[] = Array.from({ length: 10 }, (_, i): CallCheckResult => {
  const mode = MODES[i % MODES.length];
  const connected = mode !== 'host' && mode !== 'swarm';
  return {
    run: (0x1a2b3c4d + i * 7919).toString(16).slice(0, 8),
    kind: i === 9 ? 'load' : 'connect',
    mode,
    role: i < 5 ? 'caller' : 'answerer',
    connected,
    ...(connected
      ? { msToConnect: 400 + i * 97, rttMs: 30 + i * 3, audioDelayMs: 90 + i * 11, checksSent: 41, checksAnswered: 8, localType: 'srflx', remoteType: 'srflx', lossInPct: 0, sentFps: 30, receivedFps: 29 }
      : { failedAt: 'ice', checksSent: 0, checksAnswered: 0 }),
    descriptionParts: 1,
  } as CallCheckResult;
});
const callCheck = { results, onResult: () => () => undefined } as unknown as CallCheck;

function circleTab(person: string | null): React.ReactNode {
  return (
    <div className="workbench" style={{ display: 'flex', justifyContent: 'flex-end', height: '100vh' }}>
      <CircleTab
        circle={circle}
        circles={circles}
        channels={[{ id: 'general', name: 'General', unread: 0 }]}
        hints={{}}
        person={person}
        onPerson={none}
        onClose={none}
        onInvite={none}
        onConfirm={none}
        onChannelSheet={none}
        onCallCheck={none}
      />
    </div>
  );
}

const project: HermesProjectRecord = {
  id: 'p1',
  name: 'Job Search',
  hostPath: '/Users/ada/Documents/Job Search',
  containerPath: '/opt/projects/job-search',
  slug: 'job-search',
  kind: 'host-folder',
  inference: { mode: 'inherit' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

function projectRail(withProject: boolean): React.ReactNode {
  return (
    <div className="workbench" style={{ display: 'flex', justifyContent: 'flex-end', height: '100vh' }}>
      <aside className="wb-right">
        <ProjectSourcesRail
          project={withProject ? project : null}
          inspect={
            withProject
              ? {
                  projectId: 'p1',
                  stale: false,
                  sources: [
                    { id: 'project', path: '.', hostPath: project.hostPath, retrieval: 'files', visibility: 'hub', isHub: true },
                  ],
                }
              : null
          }
          onChangeFolder={none}
          onChooseFolder={none}
          onRevealHub={none}
          onRevealSource={none}
          onRefreshIndex={none}
          onAddFolder={none}
          onRemoveSource={none}
          connecting={false}
          rpcAvailable
          role={{ label: 'This chat lives in', onMove: none }}
        />
      </aside>
    </div>
  );
}

/** Every Button variant and size beside the wb-btn classes it renders, as a sheet would hold them. */
function buttons(): React.ReactNode {
  const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } as const;
  return (
    <div className="wb-sheet-backdrop">
      <div className="wb-sheet wb-sheet-wide" style={{ display: 'grid', gap: 12 }}>
        <h2>Buttons</h2>
        <div style={row}>
          <Button>Create</Button>
          <Button variant="secondary">Cancel</Button>
          <Button variant="danger">Delete folder</Button>
          <Button variant="brand">Sign in</Button>
          <Button variant="quiet">Back</Button>
          <Button variant="link">Learn more</Button>
        </div>
        <div style={row}>
          <Button size="sm">Run</Button>
          <Button variant="secondary" size="sm">
            Rename
          </Button>
          <Button variant="danger" size="sm">
            Leave
          </Button>
          <Button variant="quiet" size="sm">
            Hide
          </Button>
        </div>
        <div style={row}>
          <button type="button" className="wb-btn-solid" style={{ width: 'auto' }}>
            wb-btn-solid
          </button>
          <button type="button" className="wb-btn-ghost" style={{ width: 'auto' }}>
            wb-btn-ghost
          </button>
          <button type="button" className="wb-btn-danger">
            wb-btn-danger
          </button>
          <button type="button" className="wb-btn-tiny">
            wb-btn-tiny
          </button>
          <button type="button" className="wb-btn-tiny is-danger">
            is-danger
          </button>
        </div>
        <Button block>Continue</Button>
      </div>
    </div>
  );
}

const TONES = ['default', 'info', 'ok', 'warn', 'destructive', 'code'] as const;

/** Every Callout tone in each layout, as a sheet would hold them. */
function callouts(): React.ReactNode {
  return (
    <div className="wb-sheet-backdrop">
      <div className="wb-sheet wb-sheet-wide" style={{ display: 'grid', gap: 8 }}>
        <h2>Callouts</h2>
        {TONES.map((tone) => (
          <Callout key={tone} variant={tone} layout="row" size="sm">
            <p>A {tone} callout with its message first and a button after it on the same line.</p>
            <button type="button" className="wb-btn-tiny">
              Fix
            </button>
          </Callout>
        ))}
        <Callout variant="warn" layout="stacked" size="sm">
          <b>Stacked</b>
          <p>The message, then a row of actions under it.</p>
          <div className="wb-callout-actions">
            <button type="button" className="wb-btn-tiny">
              Try again
            </button>
            <button type="button" className="wb-btn-tiny">
              Dismiss
            </button>
          </div>
        </Callout>
        <RetryCallout message="Couldn’t load your logins." onRetry={none} />
        <Callout variant="info">A block callout at the default size, as setup uses it.</Callout>
      </div>
    </div>
  );
}

const VIEWS: Record<string, React.ReactNode> = {
  updates: <SettingsSheet request={{ tab: 'updates' }} onClose={none} />,
  access: <SettingsSheet request={{ tab: 'access' }} onClose={none} />,
  browser: <SettingsSheet request={{ tab: 'browser' }} onClose={none} />,
  'circle-start': (
    <StartJoinSheets sheet="start" displayName="" joinWaiting={false} onClose={none} onCreated={none} onJoining={none} />
  ),
  'circle-join': (
    <StartJoinSheets sheet="join" displayName="Ada" joinWaiting onClose={none} onCreated={none} onJoining={none} />
  ),
  'circle-tab': circleTab(null),
  'circle-person': circleTab('bb'.repeat(32)),
  callouts: callouts(),
  buttons: buttons(),
  project: projectRail(true),
  'project-empty': projectRail(false),
  'call-check': <CallCheckSheet check={callCheck} circle={circle} open onClose={none} />,
  'channel-add': (
    <ChannelSheets circleKey={'cc'.repeat(32)} circleName="Book club" sheet={{ kind: 'add' }} onClose={none} onAdded={none} />
  ),
};

createRoot(document.getElementById('root')!).render(VIEWS[params.get('view') ?? 'updates'] ?? VIEWS.updates);
