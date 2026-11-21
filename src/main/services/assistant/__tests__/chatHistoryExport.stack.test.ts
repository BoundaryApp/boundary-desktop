/**
 * Stack contract: `scripts/sessions.sh export --dest DIR --json` (CR 0039 R1, stack v0.3.16) as
 * Boundary's Export history runs it (ADR 0070 §2, §14). The stack's `scripts/` and compose file
 * are copied into a temp folder, and `SESSIONS_PY` (the script's own test hook) points the
 * module at a throwaway container of the pinned Hermes image over a synthetic Hermes home, so
 * no real chat is read and nothing in the stack tree changes. Needs the stack's checkout,
 * Docker and the image, not a running stack.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatHistoryState } from '../../../../shared/types/chatHistory';
import { createFakeStackFiles } from '../../stackHost/fakeStackFiles';
import { localRunScript } from '../../stackHost/localScript';
import { createChatHistoryMover } from '../chatHistory/chatHistoryExport';
import { runSessionsExport } from '../chatHistory/sessionsExport';
import type { HermesAgentsStoreShape } from '../hermes/hermesAgentStore';
import { defaultStackRoot } from './stackHarness';

const root = process.env.BOUNDARY_ASSISTANT_ROOT?.trim() || defaultStackRoot();

function pinnedImage(): string | null {
  if (!root) return null;
  try {
    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    const tag = /hermes-agent:\$\{HERMES_AGENT_IMAGE_TAG:-([^}]+)\}/.exec(compose)?.[1];
    return tag ? `nousresearch/hermes-agent:${tag}` : null;
  } catch {
    return null;
  }
}

function imagePresent(image: string | null): boolean {
  if (!image) return false;
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const image = pinnedImage();
const hasScript = !!root && fs.existsSync(path.join(root, 'scripts', 'sessions.sh'));
const ready = hasScript && imagePresent(image);
const skipReason = !hasScript ? 'no scripts/sessions.sh in the stack folder' : `${image ?? 'the Hermes image'} not present`;

/** Text the seeded titles and messages carry; no line Boundary reads may show it. */
const MARKER = 'SYNTHETIC-SECRET';

describe.skipIf(!ready)(`sessions.sh export through Boundary's runner${ready ? '' : ` (skipped: ${skipReason})`}`, () => {
  let tmp: string;
  let stack: string;
  let home: string;
  let parent: string;

  const python = (homeDir: string) =>
    ['docker', 'run', '--rm', '-i', '-u', 'hermes', '-v', `${homeDir}:/opt/data`, '-w', '/opt/hermes', '--entrypoint', '/opt/hermes/.venv/bin/python', image!];

  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-history-stack-')));
    stack = path.join(tmp, 'stack');
    home = path.join(tmp, 'home');
    parent = path.join(tmp, 'out');
    fs.mkdirSync(stack);
    fs.mkdirSync(parent);
    fs.cpSync(path.join(root!, 'scripts'), path.join(stack, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(root!, 'docker-compose.yml'), path.join(stack, 'docker-compose.yml'));
    fs.writeFileSync(path.join(stack, '.env'), '');
    fs.mkdirSync(path.join(home, 'profiles', 'coder'), { recursive: true });
    for (const dir of [home, path.join(home, 'profiles'), path.join(home, 'profiles', 'coder')]) fs.chmodSync(dir, 0o777);

    const seed = `
import sys, time
sys.path.insert(0, "/opt/hermes")
from pathlib import Path
from hermes_state import SessionDB
def sess(sid, n):
    return {"id": sid, "source": "cli", "title": f"${MARKER} {sid}", "started_at": time.time() - 100,
            "messages": [{"role": "user" if i % 2 == 0 else "assistant", "content": f"${MARKER} {sid} {i}",
                          "timestamp": time.time() - 50 + i} for i in range(n)]}
for path, sessions in (("/opt/data/state.db", [sess("s-chat", 3), sess("s-room", 2)]),
                       ("/opt/data/profiles/coder/state.db", [sess("s-dm", 4)])):
    db = SessionDB(db_path=Path(path))
    res = db.import_sessions(sessions)
    assert res["ok"] and res["imported"] == len(sessions), res
    db.close()
`;
    const [cmd, ...args] = python(home);
    execFileSync(cmd, [...args, '-'], { input: seed, stdio: ['pipe', 'ignore', 'pipe'] });
  });

  afterAll(() => {
    if (!tmp) return;
    // The image wrote as the hermes user; hand the files back before removing them.
    try {
      execFileSync('docker', ['run', '--rm', '-u', '0', '-v', `${tmp}:/t`, '--entrypoint', 'chown', image!, '-R', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, '/t'], { stdio: 'ignore' });
    } catch {
      /* best effort */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('exports every profile with counts only, then writes boundary.json beside the files', async () => {
    const store: HermesAgentsStoreShape = {
      agents: [
        { slug: 'assistant', displayName: 'Marlow', handle: 'Marlow', role: '', builtIn: true, createdAt: 'c' },
        { slug: 'coder', displayName: 'Coder', handle: 'Coder', role: '', builtIn: false, createdAt: 'c' },
      ],
      standingDmByAgent: { coder: 's-dm' },
      sessionMeta: { 's-chat': { agentSlug: 'assistant' }, 's-dm': { agentSlug: 'coder' }, 's-room': { agentSlug: 'assistant', channelId: 'c-1' } },
      channels: [{ id: 'c-1', slug: 'room', title: 'Room', sessionId: 's-room', memberSlugs: ['coder'], createdAt: 'c', updatedAt: 'u' }],
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
    const states: ChatHistoryState[] = [];
    const logs: unknown[] = [];
    const mover = createChatHistoryMover({
      commands: () => ({ runScript: localRunScript(stack), scriptEnv: async () => ({ PATH: process.env.PATH, HOME: process.env.HOME }) }),
      files: () => createFakeStackFiles({ 'data:hermes/profiles/coder/SOUL.md': '# Coder\n' }),
      readStore: () => structuredClone(store),
      listProjects: () => [],
      listWritingVoices: () => [],
      profileLabel: () => null,
      appVersion: () => 'test',
      source: () => ({ stack: 'local' }),
      unavailable: () => null,
      now: () => new Date(),
      log: (message, data) => logs.push([message, data]),
      onChange: (state) => states.push(state),
      scriptEnv: { SESSIONS_PY: python(home).join(' ') },
    });

    expect(await mover.exportTo(parent)).toBe(true);
    const last = states.at(-1);
    expect(last).toMatchObject({ phase: 'exported', sessions: 3, messages: 9 });
    if (last?.phase !== 'exported') return;
    expect(last.profiles).toEqual([
      { profile: 'default', label: null, sessions: 2, messages: 5 },
      { profile: 'coder', label: null, sessions: 1, messages: 4 },
    ]);
    expect(fs.readdirSync(last.folder).sort()).toEqual(['boundary.json', 'coder.jsonl', 'default.jsonl', 'manifest.json']);
    expect(fs.statSync(path.join(last.folder, 'boundary.json')).mode & 0o777).toBe(0o600);

    const manifest = JSON.parse(fs.readFileSync(path.join(last.folder, 'manifest.json'), 'utf8'));
    expect(manifest.format).toBe('assistant-sessions/1');
    expect(manifest.profiles.map((p: { name: string; sessions: number }) => [p.name, p.sessions])).toEqual([
      ['default', 2],
      ['coder', 1],
    ]);

    const history = JSON.parse(fs.readFileSync(path.join(last.folder, 'boundary.json'), 'utf8'));
    expect(history.format).toBe('boundary-history/1');
    expect(Object.fromEntries(Object.entries(history.sessions).map(([id, s]) => [id, (s as { profile: string }).profile]))).toEqual({
      's-chat': 'default',
      's-dm': 'coder',
      's-room': 'default',
    });

    // Nothing Boundary showed or logged carries a title or message text.
    expect(JSON.stringify([states, logs])).not.toContain(MARKER);
  });

  it('refuses a folder the stack didn’t get empty, as bad_input', async () => {
    const dest = path.join(tmp, 'not-empty');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'x'), '');
    const outcome = await runSessionsExport({
      commands: { runScript: localRunScript(stack), scriptEnv: async () => ({ PATH: process.env.PATH, HOME: process.env.HOME }) },
      dest,
      env: { SESSIONS_PY: python(home).join(' ') },
    });
    expect(outcome).toMatchObject({ kind: 'failed', error: 'bad_input' });
  });
});
