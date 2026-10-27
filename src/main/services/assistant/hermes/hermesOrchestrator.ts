import { createHash } from 'node:crypto';
import { createHermesAgent, updateHermesAgent } from './hermesAgents';
import { getOrchestratorRecord, getStoredAgent, setOrchestratorRecord } from './hermesAgentStore';
import { getHermesGatewaySession } from './hermesGatewaySession';
import { broadcastSessionsChanged } from './hermesSessionsChanged';

/**
 * The orchestrator: a personality with Hermes's kanban toolset, for long-running work. Hermes
 * shows the kanban_* tools only to profiles that name `kanban` in their toolsets, so it gets
 * its own profile instead of widening the default one every platform shares. The board
 * itself is shared across profiles; the dispatcher in the default gateway runs its tasks.
 */
const ORCHESTRATOR_SLUG = 'orchestrator';
export const ORCHESTRATOR_DISPLAY_NAME = 'Orchestrator';
export const ORCHESTRATOR_ROLE = [
  'Coordinate long-running, multi-step work on the Hermes kanban board.',
  'When a request will take many steps or outlast one sitting, break it into tasks with kanban_create:',
  'a clear title, a body that says what done looks like, and an assignee (yourself, or the',
  'specialist agent whose role fits). Unassigned tasks never run, so always set one.',
  'File every task with workspace_kind "scratch". For work in a repo or folder, put its absolute',
  'path in the body: the board can\'t write to those folders, so it refuses "dir" and "worktree"',
  'tasks on them, but the worker\'s terminal can work there.',
  'Set max_runtime_seconds on every task: 7200 unless the work clearly needs longer. A worker',
  'stuck in one endless reply keeps reporting in, so the cap is the only thing that stops it.',
  'Chain tasks that depend on each other with kanban_link.',
  'Track them with kanban_list and kanban_show, unblock or answer tasks that are waiting,',
  'and tell the owner what finished and what is still open.',
  'When a task gives up because the board can\'t build its workspace, move it with',
  'kanban_update(workspace_kind="scratch"), then kanban_unblock it. Clear away a task that is',
  'no longer needed with kanban_archive.',
  'Handle quick, single-step requests yourself without the board.',
].join(' ');

/**
 * SHA-256 of earlier built-in roles, newest first. An orchestrator still on one of them, word
 * for word, is moved to the current role; one the owner rewrote is left alone. When the role
 * changes, add the hash of the one it replaces.
 *
 * One-time migration kept at read time rather than in src/main/migrations: rewriting the role
 * needs the gateway, and each stack has its own orchestrator. Remove after release 0.1.0.
 */
const PREVIOUS_ORCHESTRATOR_ROLE_HASHES = new Set([
  '18472d64d7402ee07c9a5dad3b2f231ae060e8954de9a024196a9567092ee045',
  '8b6e42c6c85d20b00b394a2435671706ba8c119e65919bdbf38fe5f1dab93c49',
  'd9fe2e6cf49f27919404da9bc4cff36a3445c0e097ac68f99f206ae7df2b1c3f',
]);

function roleHash(role: string): string {
  return createHash('sha256').update(role.trim()).digest('hex');
}

/** Wait after a failed setup, doubling each time up to the cap, so list refreshes don't hammer Hermes. */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;

let inflight: Promise<void> | null = null;
let failures = 0;
let nextAttemptAt = 0;

/**
 * Create the orchestrator once per stack and give its profile the kanban toolset. Safe to
 * call often: it does nothing once both are done, and after a failure it waits (with
 * backoff) before retrying whatever failed.
 */
export function ensureOrchestratorAgent(): Promise<void> {
  if (inflight) return inflight;
  if (Date.now() < nextAttemptAt) return Promise.resolve();
  inflight = provision()
    .catch((err) => {
      console.warn('[hermesOrchestrator] setup did not finish', err);
      return false;
    })
    .then((done) => {
      if (done) {
        failures = 0;
        nextAttemptAt = 0;
      } else {
        failures += 1;
        nextAttemptAt = Date.now() + Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
      }
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** True once the agent exists and its profile has kanban. */
async function provision(): Promise<boolean> {
  const record = getOrchestratorRecord();
  if (record?.slug) await refreshOutdatedRole(record.slug);
  if (record?.kanbanEnabled) return true;

  const gateway = getHermesGatewaySession();
  await gateway.ensureConnected();

  let slug = record?.slug ?? null;
  if (!slug) {
    // Adopt an agent the owner already made under this name rather than adding a second one.
    if (getStoredAgent(ORCHESTRATOR_SLUG)) {
      slug = ORCHESTRATOR_SLUG;
    } else {
      const created = await createHermesAgent({
        displayName: ORCHESTRATOR_DISPLAY_NAME,
        handle: ORCHESTRATOR_SLUG,
        role: ORCHESTRATOR_ROLE,
      });
      if (!created.success || !created.agent) return false;
      slug = created.agent.slug;
    }
    setOrchestratorRecord({ slug, kanbanEnabled: false });
    broadcastSessionsChanged();
  }

  if (!getStoredAgent(slug)) return false;
  // tools.configure changes the profile of a live session, so open one on the orchestrator's
  // profile just for this. It stays empty and out of the agent's DM.
  const sessionId = await gateway.createSessionWithSeed({ profile: slug });
  const enabled = await gateway.enableProfileToolsets(sessionId, ['kanban'], slug);
  if (enabled) setOrchestratorRecord({ slug, kanbanEnabled: true });
  return enabled;
}

async function refreshOutdatedRole(slug: string): Promise<void> {
  const agent = getStoredAgent(slug);
  if (!agent || !PREVIOUS_ORCHESTRATOR_ROLE_HASHES.has(roleHash(agent.role))) return;
  const result = await updateHermesAgent({
    slug,
    displayName: agent.displayName,
    handle: agent.handle,
    role: ORCHESTRATOR_ROLE,
  });
  if (!result.success) console.warn('[hermesOrchestrator] role update did not finish', result.error);
}

export function resetOrchestratorForTests(): void {
  inflight = null;
  failures = 0;
  nextAttemptAt = 0;
}
