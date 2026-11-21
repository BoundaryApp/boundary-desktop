import fs from 'node:fs';
import path from 'node:path';
import type { ChatHistoryProfileCount, ChatHistoryState, ChatHistoryStatus } from '../../../../shared/types/chatHistory';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import type { WritingVoiceRecord } from '../../../../shared/types/writingVoices';
import type { StackCommands, StackFiles } from '../../stackHost/types';
import { readSoulFile } from '../hermes/agentSoul';
import type { HermesAgentsStoreShape } from '../hermes/hermesAgentStore';
import {
  BOUNDARY_HISTORY_FILE,
  buildBoundaryHistory,
  type BoundaryHistoryFile,
} from './boundaryHistory';
import { runSessionsExport, type SessionsExportOutcome } from './sessionsExport';

// Export history… (ADR 0070 §2–4, §11): one folder holding the stack's export and Boundary's
// `boundary.json`. One history action runs at a time; Cancel stops the script and deletes the
// folder Boundary created. Logs carry counts and profile names only.

export interface ChatHistoryDeps {
  commands: () => Pick<StackCommands, 'runScript' | 'scriptEnv'>;
  files: () => StackFiles;
  readStore: () => HermesAgentsStoreShape;
  listProjects: () => HermesProjectRecord[];
  listWritingVoices: () => WritingVoiceRecord[];
  /** The agent's name for a profile, or null when Boundary has no record of it. */
  profileLabel: (profile: string) => string | null;
  appVersion: () => string;
  source: () => BoundaryHistoryFile['source'];
  /** Why history can't move on this stack host, or null. */
  unavailable: () => string | null;
  now: () => Date;
  log: (message: string, data: Record<string, unknown>) => void;
  onChange: (state: ChatHistoryState) => void;
  /** Extra environment for the script, for the `test:stack` case. */
  scriptEnv?: NodeJS.ProcessEnv;
}

/** `Boundary history 2026-11-20`, in local time. */
export function exportFolderName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Boundary history ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Makes a new folder in `parent` (mode 0700), adding ` 2`, ` 3`… when the name is taken. */
async function makeExportFolder(parent: string, name: string): Promise<string> {
  for (let n = 1; ; n += 1) {
    const folder = path.join(parent, n === 1 ? name : `${name} ${n}`);
    try {
      await fs.promises.mkdir(folder, { mode: 0o700 });
      return folder;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 100) throw e;
    }
  }
}

/** What the panel says for a failed export. */
function exportFailureText(outcome: Extract<SessionsExportOutcome, { kind: 'failed' }>): string {
  if (outcome.error === 'hermes_not_running') {
    return 'The agent isn’t running, so its chats can’t be read. Start it and try again.';
  }
  return outcome.message ? `The export failed (${outcome.error}): ${outcome.message}` : `The export failed (${outcome.error}).`;
}

export interface ChatHistoryMover {
  status(): ChatHistoryStatus;
  /**
   * Starts an export into a new folder in `parent`. Resolves once the run has ended; `false`
   * when another history action was already running or history can't move here.
   */
  exportTo(parent: string): Promise<boolean>;
  /** Stops the running action. True when one was running. */
  cancel(): boolean;
}

export function createChatHistoryMover(deps: ChatHistoryDeps): ChatHistoryMover {
  let state: ChatHistoryState = { phase: 'idle' };
  let running: AbortController | null = null;

  const set = (next: ChatHistoryState) => {
    state = next;
    deps.onChange(next);
  };
  const counted = (lines: { profile: string; sessions: number; messages: number }[]): ChatHistoryProfileCount[] =>
    lines.map((l) => ({ ...l, label: deps.profileLabel(l.profile) }));

  const writeBoundaryFile = async (folder: string): Promise<{ agents: number; sessions: number; soulsMissing: number }> => {
    const store = deps.readStore();
    const files = deps.files();
    const souls: Record<string, string | null> = {};
    for (const agent of store.agents ?? []) souls[agent.slug] = await readSoulFile(files, agent.slug);
    const history = buildBoundaryHistory({
      store,
      souls,
      projects: deps.listProjects(),
      writingVoices: deps.listWritingVoices(),
      appVersion: deps.appVersion(),
      source: deps.source(),
      now: deps.now(),
    });
    await fs.promises.writeFile(path.join(folder, BOUNDARY_HISTORY_FILE), `${JSON.stringify(history, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    return {
      agents: history.agents.length,
      sessions: Object.keys(history.sessions).length,
      soulsMissing: Object.values(souls).filter((s) => s === null).length,
    };
  };

  const removeFolder = async (folder: string) => {
    try {
      await fs.promises.rm(folder, { recursive: true, force: true });
    } catch (e) {
      deps.log('export folder not removed', { error: (e as NodeJS.ErrnoException).code ?? 'unknown' });
    }
  };

  const exportTo = async (parent: string): Promise<boolean> => {
    if (running || deps.unavailable()) return false;
    const controller = new AbortController();
    running = controller;
    let folder: string | null = null;
    try {
      folder = await makeExportFolder(parent, exportFolderName(deps.now()));
      const shown: ChatHistoryProfileCount[] = [];
      set({ phase: 'exporting', folder, profiles: [], cancelling: false });
      deps.log('export started', {});
      const outcome = await runSessionsExport({
        commands: deps.commands(),
        dest: folder,
        signal: controller.signal,
        env: deps.scriptEnv,
        onProfile: (line) => {
          shown.push(...counted([line]));
          deps.log('export profile', { profile: line.profile, sessions: line.sessions, messages: line.messages });
          if (state.phase === 'exporting') set({ ...state, profiles: [...shown] });
        },
      });
      if (outcome.kind === 'done' && !controller.signal.aborted) {
        const written = await writeBoundaryFile(folder);
        if (!controller.signal.aborted) {
          deps.log('export done', {
            profiles: outcome.profiles.length,
            sessions: outcome.sessions,
            messages: outcome.messages,
            boundarySessions: written.sessions,
            agents: written.agents,
            soulsMissing: written.soulsMissing,
          });
          set({
            phase: 'exported',
            folder,
            profiles: counted(outcome.profiles),
            sessions: outcome.sessions,
            messages: outcome.messages,
          });
          return true;
        }
      }
      await removeFolder(folder);
      if (outcome.kind === 'failed') {
        deps.log('export failed', { error: outcome.error });
        set({ phase: 'failed', error: exportFailureText(outcome) });
      } else {
        deps.log('export cancelled', {});
        set({ phase: 'cancelled' });
      }
      return true;
    } catch (e) {
      if (folder) await removeFolder(folder);
      const code = (e as NodeJS.ErrnoException).code;
      deps.log('export failed', { error: code ?? 'exception' });
      set({ phase: 'failed', error: `The export failed: ${e instanceof Error ? e.message : String(e)}` });
      return true;
    } finally {
      running = null;
    }
  };

  return {
    status: () => ({ state, unavailable: deps.unavailable() }),
    exportTo,
    cancel: () => {
      if (!running) return false;
      running.abort();
      if (state.phase === 'exporting') set({ ...state, cancelling: true });
      return true;
    },
  };
}
