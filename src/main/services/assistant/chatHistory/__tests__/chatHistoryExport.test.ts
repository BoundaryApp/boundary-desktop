import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatHistoryState } from '../../../../../shared/types/chatHistory';
import { createFakeStackFiles } from '../../../stackHost/fakeStackFiles';
import { SCRIPT_CANCELLED } from '../../../stackHost/localScript';
import type { RunScriptOptions } from '../../../stackHost/types';
import type { HermesAgentsStoreShape } from '../../hermes/hermesAgentStore';
import { createChatHistoryMover, exportFolderName, type ChatHistoryDeps } from '../chatHistoryExport';

// The mover against a fake `sessions.sh` that writes what the real export writes (one
// `<profile>.jsonl` and `manifest.json`) and prints its v0.3.16 lines, into a real temp folder.

const STORE: HermesAgentsStoreShape = {
  agents: [
    { slug: 'assistant', displayName: 'Marlow', handle: 'Marlow', role: '', builtIn: true, createdAt: 'c' },
    { slug: 'coder', displayName: 'Coder', handle: 'Coder', role: '', builtIn: false, createdAt: 'c' },
  ],
  standingDmByAgent: { coder: 's-dm' },
  sessionMeta: { 's-dm': { agentSlug: 'coder' } },
  channels: [],
  lastOpened: null,
  sessionSpeakers: {},
  channelPosts: {},
  sessionInferenceMarks: {},
  sessionWritingVoiceMarks: {},
  sessionProjectMarks: {},
  replyEndings: {},
  replyWritingVoices: {},
  promptWritingVoices: {},
  noReplies: {},
  mentionsSeenAt: null,
};

let parent: string;
let states: ChatHistoryState[];
let logs: Array<[string, Record<string, unknown>]>;

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-history-'));
  states = [];
  logs = [];
});
afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

type Script = (dest: string, options: RunScriptOptions) => Promise<number>;

const exportScript: Script = async (dest, options) => {
  fs.writeFileSync(path.join(dest, 'default.jsonl'), '{"id":"s-1"}\n', { mode: 0o600 });
  options.onStdout('{"phase":"profile","profile":"default","sessions":1,"messages":2}');
  fs.writeFileSync(path.join(dest, 'coder.jsonl'), '{"id":"s-dm"}\n', { mode: 0o600 });
  options.onStdout('{"phase":"profile","profile":"coder","sessions":1,"messages":3}');
  fs.writeFileSync(path.join(dest, 'manifest.json'), '{"format":"assistant-sessions/1"}\n');
  options.onStdout(JSON.stringify({ phase: 'done', action: 'export', dest, sessions: 2, messages: 5 }));
  return 0;
};

function mover(script: Script, overrides: Partial<ChatHistoryDeps> = {}) {
  const files = createFakeStackFiles({ 'data:hermes/SOUL.md': '# Marlow\n', 'data:hermes/profiles/coder/SOUL.md': '# Coder\n' });
  return createChatHistoryMover({
    commands: () => ({
      scriptEnv: async () => ({}),
      runScript: (_script, args, options) => script(args[2], options),
    }),
    files: () => files,
    readStore: () => structuredClone(STORE),
    listProjects: () => [],
    listWritingVoices: () => [],
    profileLabel: (p) => (p === 'default' ? 'Marlow' : p === 'coder' ? 'Coder' : null),
    appVersion: () => '1.2.3',
    source: () => ({ stack: 'local' }),
    unavailable: () => null,
    now: () => new Date(2026, 10, 20, 9, 30),
    log: (message, data) => logs.push([message, data]),
    onChange: (state) => states.push(state),
    ...overrides,
  });
}

describe('chat history export', () => {
  it('names the folder by local date', () => {
    expect(exportFolderName(new Date(2026, 0, 5, 23, 59))).toBe('Boundary history 2026-01-05');
  });

  it('exports into a new folder and writes boundary.json beside the stack’s files', async () => {
    const m = mover(exportScript);
    expect(await m.exportTo(parent)).toBe(true);
    const folder = path.join(parent, 'Boundary history 2026-11-20');
    expect(fs.readdirSync(folder).sort()).toEqual(['boundary.json', 'coder.jsonl', 'default.jsonl', 'manifest.json']);
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(folder, 'boundary.json')).mode & 0o777).toBe(0o600);
    const history = JSON.parse(fs.readFileSync(path.join(folder, 'boundary.json'), 'utf8'));
    expect(history).toMatchObject({ format: 'boundary-history/1', appVersion: '1.2.3', source: { stack: 'local' } });
    expect(history.agents.map((a: { slug: string; soul: string }) => [a.slug, a.soul])).toEqual([
      ['assistant', '# Marlow\n'],
      ['coder', '# Coder\n'],
    ]);
    expect(history.sessions['s-dm']).toEqual({ profile: 'coder', meta: { agentSlug: 'coder' } });

    expect(states.at(-1)).toEqual({
      phase: 'exported',
      folder,
      sessions: 2,
      messages: 5,
      profiles: [
        { profile: 'default', label: 'Marlow', sessions: 1, messages: 2 },
        { profile: 'coder', label: 'Coder', sessions: 1, messages: 3 },
      ],
    });
    // Progress came per profile line.
    expect(states.filter((s) => s.phase === 'exporting').map((s) => (s.phase === 'exporting' ? s.profiles.length : -1))).toEqual([0, 1, 2]);
  });

  it('logs counts and profile names, never the folder or content', async () => {
    await mover(exportScript).exportTo(parent);
    const text = JSON.stringify(logs);
    expect(logs.map(([message]) => message)).toEqual(['export started', 'export profile', 'export profile', 'export done']);
    expect(text).not.toContain(parent);
    expect(text).not.toContain('# Marlow');
  });

  it('adds a number when the day’s folder already exists, and never writes into it', async () => {
    fs.mkdirSync(path.join(parent, 'Boundary history 2026-11-20'));
    await mover(exportScript).exportTo(parent);
    expect(fs.readdirSync(path.join(parent, 'Boundary history 2026-11-20'))).toEqual([]);
    expect(fs.existsSync(path.join(parent, 'Boundary history 2026-11-20 2', 'boundary.json'))).toBe(true);
  });

  it('runs one export at a time, and Cancel deletes the folder it made', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const m = mover(async (dest, options) => {
      fs.writeFileSync(path.join(dest, 'default.jsonl'), 'partial');
      options.onStdout('{"phase":"profile","profile":"default","sessions":1,"messages":2}');
      started();
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve()));
      return SCRIPT_CANCELLED;
    });
    const first = m.exportTo(parent);
    await running;
    expect(await m.exportTo(parent)).toBe(false);
    expect(m.cancel()).toBe(true);
    expect(states.at(-1)).toMatchObject({ phase: 'exporting', cancelling: true });
    await first;
    expect(states.at(-1)).toEqual({ phase: 'cancelled' });
    expect(fs.readdirSync(parent)).toEqual([]);
    expect(m.cancel()).toBe(false);
  });

  it('deletes the folder and names the error when the export fails', async () => {
    const m = mover(async (_dest, options) => {
      options.onStdout('{"phase":"error","error":"hermes_not_running","step":"profiles","message":"could not run python in the hermes service; start the stack with make up","logTail":[]}');
      return 1;
    });
    await m.exportTo(parent);
    expect(fs.readdirSync(parent)).toEqual([]);
    expect(states.at(-1)).toEqual({ phase: 'failed', error: expect.stringMatching(/agent isn’t running/) });
    expect(logs.at(-1)).toEqual(['export failed', { error: 'hermes_not_running' }]);
  });

  it('refuses on a stack host that can’t move history', async () => {
    const m = mover(exportScript, { unavailable: () => 'remote' });
    expect(await m.exportTo(parent)).toBe(false);
    expect(m.status()).toEqual({ state: { phase: 'idle' }, unavailable: 'remote' });
    expect(fs.readdirSync(parent)).toEqual([]);
  });
});
