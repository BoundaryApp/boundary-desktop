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
import { MoreHorizontal, PanelRight, Plus, X } from 'lucide-react';
import { Button } from '../../src/renderer/components/ui/button';
import { Checkbox } from '../../src/renderer/components/ui/checkbox';
import { Field } from '../../src/renderer/components/ui/field';
import { Input } from '../../src/renderer/components/ui/input';
import { NativeSelect } from '../../src/renderer/components/ui/native-select';
import { PasswordField } from '../../src/renderer/components/ui/password-field';
import { Select, SelectTrigger, SelectValue } from '../../src/renderer/components/ui/select';
import { Textarea } from '../../src/renderer/components/ui/textarea';
import { ChoiceGroup } from '../../src/renderer/components/ui/choice-group';
import { ChoiceRow } from '../../src/renderer/components/ui/choice-row';
import { Chip } from '../../src/renderer/components/ui/chip';
import { ChipGroup } from '../../src/renderer/components/ui/chip-group';
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuNote,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from '../../src/renderer/components/ui/menu';
import { Listbox, ListboxGroup, ListboxOption } from '../../src/renderer/components/ui/listbox';
import { Segmented } from '../../src/renderer/components/ui/segmented';
import { Radio } from '../../src/renderer/components/ui/radio';
import { Switch } from '../../src/renderer/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../src/renderer/components/ui/tabs';
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
  new Proxy<() => undefined>(() => undefined, {
    get: (_target, key): unknown => (typeof key === 'string' && key.startsWith('on') ? (): (() => void) => none : inert()),
    apply: () => Promise.resolve(null),
  });
const updates = {
  getState: () => Promise.resolve(state),
  onState: (): (() => void) => none,
  closeCard: () => Promise.resolve(),
};
/** Bridge namespaces whose calls need a real-looking reply; the rest are inert. */
const bridge: Record<string, unknown> = {
  updates,
  codingFolders: {
    list: () => Promise.resolve({ success: true, managed: true, grants: [] }),
    busy: () => Promise.resolve({ busy: false, sessions: [] }),
    onProgress: (): (() => void) => none,
  },
  circles: {
    foldersOnMac: () => Promise.resolve({ success: true, folders: [] }),
    notifyPrefs: () =>
      Promise.resolve({
        prefs: { level: 'default', channelMentions: true },
        resolved: 'all',
        people: 3,
        global: { enabled: true, showText: true },
      }),
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

const none = (): void => undefined;

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
  format: 3,
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
const callCheck = { results, onResult: (): (() => void) => none } as unknown as CallCheck;

function circleTab(person: string | null): React.ReactNode {
  return (
    <div className="workbench" style={{ display: 'flex', justifyContent: 'flex-end', height: '100vh' }}>
      <CircleTab
        circle={circle}
        circles={circles}
        channels={[{ id: 'general', name: 'General', unread: 0, mentioned: false }]}
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

/** Checkbox, Radio and Switch in each state, in plain and card rows, and a radio group. */
function choices(): React.ReactNode {
  const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } as const;
  return (
    <div className="wb-sheet-backdrop">
      <div className="wb-sheet wb-sheet-wide" style={{ display: 'grid', gap: 12 }}>
        <h2>Choices</h2>
        <div style={row}>
          <Checkbox aria-label="checkbox off" />
          <Checkbox aria-label="checkbox on" defaultChecked />
          <Checkbox aria-label="checkbox disabled" disabled />
          <Checkbox aria-label="checkbox disabled on" disabled defaultChecked />
          <Checkbox aria-label="checkbox invalid" aria-invalid />
          <Radio name="states-a" aria-label="radio off" />
          <Radio name="states-b" aria-label="radio on" defaultChecked />
          <Radio name="states-c" aria-label="radio disabled" disabled />
          <Radio name="states-d" aria-label="radio invalid" aria-invalid />
          <Switch label="switch off" checked={false} onChange={none} />
          <Switch label="switch on" checked onChange={none} />
          <Switch label="switch disabled" checked={false} disabled onChange={none} />
        </div>
        <ChoiceRow control={<Checkbox defaultChecked />} title="Plain checkbox row" />
        <ChoiceRow control={<Radio name="plain" />} title="Plain radio row" description="With a description under the title." />
        <ChoiceRow control={<Checkbox disabled />} title="Disabled plain row" description="Dims once, box and text together." />
        <ChoiceRow
          controlAt="end"
          control={<Switch checked onChange={none} />}
          title="Plain switch row"
          description="The switch sits at the row's end."
        />
        <ChoiceRow variant="card" control={<Checkbox defaultChecked />} title="Card checkbox row" description="Tinted border while checked." />
        <ChoiceRow variant="card" control={<Radio name="card" disabled />} title="Disabled card row" description="Dims once." />
        <ChoiceRow
          variant="card"
          controlAt="end"
          control={<Switch checked={false} disabled onChange={none} />}
          title="Disabled card switch row"
          description="Dims once."
        />
        <ChoiceGroup label="How it unlocks" kind="radio" hint="You can change this later.">
          <ChoiceRow control={<Radio name="unlock" defaultChecked />} title="Ask each time" description="Type the password when needed." />
          <ChoiceRow control={<Radio name="unlock" />} title="Remember it" description="Kept in the keychain." />
        </ChoiceGroup>
        <ChoiceGroup label="Where it runs" kind="radio">
          <ChoiceRow variant="card" control={<Radio name="where" defaultChecked />} title="This Mac" description="Card rows in a group." />
          <ChoiceRow variant="card" control={<Radio name="where" />} title="A pool" description="Another card." />
        </ChoiceGroup>
      </div>
    </div>
  );
}

/** Choice cards, Segmented at each size and state, and single and multiple ChipGroups. */
function toggles(): React.ReactNode {
  const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 12 } as const;
  const access = [
    { value: 'read', label: 'Read-only' },
    { value: 'code', label: 'Code in it', disabled: true, title: 'Coding is off' },
    { value: 'write', label: 'Write' },
  ];
  const [kind, setKind] = React.useState('all');
  const [unseen, setUnseen] = React.useState(true);
  const icon = (
    <svg viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="5" fill="currentColor" />
    </svg>
  );
  return (
    <div className="wb-sheet-backdrop">
      <div className="wb-sheet wb-sheet-wide">
        <h2>Toggles</h2>
        <ChoiceGroup aria-label="Where it runs" kind="radio">
          <ChoiceRow variant="card" control={<Radio name="t-where" defaultChecked />} title="This Mac" description="The selected card." />
          <ChoiceRow variant="card" control={<Radio name="t-where" disabled />} title="A pool" description="A disabled card." />
          <ChoiceRow
            variant="card"
            control={<Radio name="t-where" />}
            title="Add folder"
            description="A card with an aside."
            aside={<span>Coding</span>}
          />
        </ChoiceGroup>
        <div style={row}>
          <Segmented aria-label="Default" value="read" onChange={none} options={access} />
          <Segmented aria-label="Small" size="sm" value="read" onChange={none} options={access} />
          <Segmented aria-label="Disabled" disabled value="read" onChange={none} options={access} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <Segmented aria-label="Block" block value="read" onChange={none} options={access} />
        </div>
        <div style={row}>
          <ChipGroup type="single" aria-label="Kind" value={kind} onValueChange={setKind}>
            <Chip value="all" icon={icon}>
              All
            </Chip>
            <Chip value="chats">Chats</Chip>
            <Chip value="calls" disabled>
              Calls
            </Chip>
          </ChipGroup>
        </div>
        <div style={row}>
          <ChipGroup type="multiple" aria-label="Filters">
            <Chip pressed={unseen} onPressedChange={setUnseen}>
              Unseen
            </Chip>
            <Chip pressed={false} disabled>
              Waiting
            </Chip>
          </ChipGroup>
        </div>
      </div>
    </div>
  );
}

/** Input, NativeSelect and Textarea at each size and state, in fields, and a Radix select trigger. */
function fields(): React.ReactNode {
  const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } as const;
  return (
    <div className="wb-sheet-backdrop">
      <div className="wb-sheet wb-sheet-wide">
        <h2>Fields</h2>
        <Field label="Server" htmlFor="f-server" hint="A default text field.">
          <Input id="f-server" placeholder="https://example.com" />
        </Field>
        <Field label="Slug" htmlFor="f-slug" hint="Invalid, not focused.">
          <Input id="f-slug" className="font-mono" aria-invalid defaultValue="Bad Slug" />
        </Field>
        <Field label="Focused slug" htmlFor="f-focus" hint="Invalid and focused: the border stays red.">
          <Input id="f-focus" className="font-mono" aria-invalid defaultValue="Also Bad" autoFocus />
        </Field>
        <Field label="Disabled" htmlFor="f-off">
          <Input id="f-off" disabled defaultValue="Can't change this" />
        </Field>
        <Field label="Password" htmlFor="f-pass">
          <PasswordField id="f-pass" defaultValue="secret" />
        </Field>
        <Field label="Account" htmlFor="f-account">
          <NativeSelect id="f-account" defaultValue="b">
            <option value="a">Personal</option>
            <option value="b">Work</option>
          </NativeSelect>
        </Field>
        <Field label="Notes" htmlFor="f-notes">
          <Textarea id="f-notes" placeholder="A text area in a field." />
        </Field>
        <Field label="Model" htmlFor="f-model">
          <Select>
            <SelectTrigger id="f-model" className="w-full">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
          </Select>
        </Field>
        <div style={row}>
          <Input size="sm" aria-label="small search" placeholder="Search" className="max-w-[200px]" />
          <NativeSelect size="sm" aria-label="small filter" defaultValue="all">
            <option value="all">All chats</option>
            <option value="mine">Mine</option>
          </NativeSelect>
          <NativeSelect size="sm" aria-label="small invalid" aria-invalid defaultValue="x">
            <option value="x">Invalid</option>
          </NativeSelect>
          <Select>
            <SelectTrigger size="sm" aria-label="small trigger">
              <SelectValue placeholder="Pick one" />
            </SelectTrigger>
          </Select>
        </div>
        <div className="wb-input-box" style={{ marginTop: 12, border: '1px solid var(--line)', borderRadius: 8, padding: 8 }}>
          <Textarea variant="bare" aria-label="bare composer" placeholder="A bare text area in a box." />
        </div>
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

/** An open Menu with every kind of item, and Listboxes: a popup with groups and a marked list in a sheet. */
function iconButtons(): React.ReactNode {
  const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } as const;
  const sizes = ['icon', 'icon-sm', 'icon-xs'] as const;
  return (
    <div className="wb-sheet-backdrop wb-sheet-still">
      <div className="wb-sheet wb-sheet-wide wb-sheet-still" style={{ display: 'grid', gap: 12 }}>
        <h2>Icon buttons</h2>
        {sizes.map((size) => (
          <div key={size} style={row}>
            <Button variant="quiet" size={size} aria-label="Close">
              <X />
            </Button>
            <Button variant="quiet" size={size} aria-label="Add">
              <Plus />
            </Button>
            <Button variant="secondary" size={size} aria-label="More">
              <MoreHorizontal />
            </Button>
            <Button variant="quiet" size={size} aria-label="Details" aria-expanded>
              <PanelRight />
            </Button>
            <Button variant="quiet" size={size} aria-label="Remove" disabled>
              <X />
            </Button>
          </div>
        ))}
        <div style={{ minHeight: 120 }}>
          <Menu open onOpenChange={none}>
            <MenuTrigger>
              <Button variant="quiet" size="icon-sm" aria-label="More for Book club">
                <MoreHorizontal />
              </Button>
            </MenuTrigger>
            <MenuContent aria-label="Book club" side="bottom" align="start">
              <MenuItem onSelect={none}>Circle details</MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>
    </div>
  );
}

function menus(): React.ReactNode {
  return (
    <div className="wb-sheet-backdrop wb-sheet-still">
      {/* Still: the menu is open from mount, and a popper measured during the rise-in lands off its trigger. */}
      <div className="wb-sheet wb-sheet-wide wb-sheet-still">
        <h2>Menus</h2>
        <div style={{ minHeight: 400, marginBottom: 16 }}>
          <Menu open onOpenChange={none}>
            <MenuTrigger>
              <Button variant="secondary">More</Button>
            </MenuTrigger>
            <MenuContent aria-label="Circle" side="bottom" align="start">
              <MenuLabel>Book club</MenuLabel>
              <MenuItem onSelect={none} hint="⌘D">
                Circle details
              </MenuItem>
              <MenuItem onSelect={none} disabled>
                Invite someone…
              </MenuItem>
              <MenuNote>Only admins can invite.</MenuNote>
              <MenuItem onSelect={none} description="A second line under the label.">
                Move to project…
              </MenuItem>
              <MenuCheckboxItem checked onCheckedChange={none}>
                Mute
              </MenuCheckboxItem>
              <MenuRadioGroup value="all" onValueChange={none}>
                <MenuRadioItem value="all">All messages</MenuRadioItem>
                <MenuRadioItem value="mentions">Mentions only</MenuRadioItem>
              </MenuRadioGroup>
              <MenuSub>
                <MenuSubTrigger hint="All">Notifications</MenuSubTrigger>
              </MenuSub>
              <MenuSeparator />
              <MenuItem onSelect={none} variant="danger">
                Leave…
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
          <Listbox id="h-mentions" aria-label="Mention">
            <ListboxGroup label="People">
              <ListboxOption id="h-m-0" active selected onPick={none}>
                Ada Lovelace
              </ListboxOption>
              <ListboxOption id="h-m-1" onPick={none} description="grace@example.com">
                Grace Hopper
              </ListboxOption>
            </ListboxGroup>
            <ListboxGroup label="Files">
              <ListboxOption id="h-m-2" disabled onPick={none} hint="2 KB">
                notes.md
              </ListboxOption>
            </ListboxGroup>
          </Listbox>
          <Listbox id="h-dest" aria-label="Destination" marks tabIndex={0} aria-activedescendant="h-d-1">
            <ListboxOption id="h-d-0" onPick={none}>
              No project
            </ListboxOption>
            <ListboxOption id="h-d-1" active selected onPick={none} description="~/Code/boundary" hint="12">
              Boundary
            </ListboxOption>
          </Listbox>
        </div>
      </div>
    </div>
  );
}

/** Tabs: a default list with a count and a disabled tab over its panel, and a bar list in a header. */
function tabs(): React.ReactNode {
  const [view, setView] = React.useState('general');
  const [dm, setDm] = React.useState('messages');
  return (
    <div className="wb-sheet-backdrop">
      <div className="wb-sheet wb-sheet-wide">
        <h2>Tabs</h2>
        <Tabs value={view} onValueChange={setView} style={{ marginBottom: 16 }}>
          <TabsList aria-label="Sections">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="files" count={12}>
              Files
            </TabsTrigger>
            <TabsTrigger value="locked" disabled>
              Locked
            </TabsTrigger>
          </TabsList>
          <TabsContent value="general">
            <p>The General panel.</p>
          </TabsContent>
          <TabsContent value="files">
            <p>The Files panel.</p>
          </TabsContent>
        </Tabs>
        <Tabs value={dm} onValueChange={setDm}>
          <div className="wb-thread-head">
            <strong>A header bar</strong>
            <TabsList aria-label="Views" variant="bar" className="ml-4">
              <TabsTrigger value="messages">Messages</TabsTrigger>
              <TabsTrigger value="channels" count={3}>
                In channels
              </TabsTrigger>
            </TabsList>
            <span className="wb-grow" aria-hidden="true" />
          </div>
        </Tabs>
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
  choices: choices(),
  fields: fields(),
  toggles: React.createElement(toggles),
  menus: menus(),
  'icon-buttons': iconButtons(),
  tabs: React.createElement(tabs),
  project: projectRail(true),
  'project-empty': projectRail(false),
  'call-check': <CallCheckSheet check={callCheck} circle={circle} open onClose={none} />,
  'channel-add': (
    <ChannelSheets circleKey={'cc'.repeat(32)} circleName="Book club" sheet={{ kind: 'add' }} onClose={none} onAdded={none} />
  ),
};

createRoot(document.getElementById('root')!).render(VIEWS[params.get('view') ?? 'updates'] ?? VIEWS.updates);
