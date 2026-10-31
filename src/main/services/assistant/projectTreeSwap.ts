import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME } from '../../../shared/buildIdentity';

/**
 * Paths inside the agent-stack tree that hold the user's data or secrets generated on
 * this machine. Everything else in the tree comes from the stack archive and is replaced
 * when Boundary moves to a new pinned ref.
 *
 * Keep in sync with the stack's .gitignore (local runtime, secrets, generated overlays).
 */
const PRESERVED_PROJECT_PATHS: readonly string[] = [
  // Hermes state and profiles (vaults, sessions, memories), WebUI, databases, projects.
  'data',
  // Generated secrets and Boundary's settings; setup.sh fills in only what is missing.
  '.env',
  'compose/hermes/api-server.env',
  'compose/hermes/browser.env',
  'compose/hermes/worker/ssh',
  'compose/caldav-mcp/accounts',
  'opencode/opencode.local.json',
  'searxng/settings.local.yml',
  'models.local.yaml',
  'docker-compose.override.yml',
];

export interface ProjectSwapPaths {
  /** The live tree compose runs from. */
  projectRoot: string;
  /** The freshly extracted tree for the new ref (same volume as projectRoot). */
  nextRoot: string;
  /** Where the old tree goes. It keeps only the old stack code once the swap is done. */
  previousRoot: string;
  /** Records an unfinished swap so the next launch can complete it. */
  journalPath: string;
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Steps that put a failed swap back, run newest first. */
type UndoStep = () => Promise<void>;

/** Paths a merge copy from `src` into `dest` would create: what only the new tree has. */
function pathsOnlyIn(src: string, dest: string): string[] {
  const added: string[] = [];
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (!exists(to)) {
      added.push(to);
    } else if (fs.lstatSync(from).isDirectory() && fs.lstatSync(to).isDirectory()) {
      added.push(...pathsOnlyIn(from, to));
    }
  }
  return added;
}

/**
 * Move one preserved path from the old tree into the new one. A directory is moved
 * whole, then anything only the new tree had (e.g. a tracked .gitkeep) is copied in
 * without overwriting. With `undo`, records how to move it back.
 */
async function carryOver(from: string, to: string, undo?: UndoStep[]): Promise<void> {
  if (!exists(from)) {
    // Already moved; drop a leftover copy of the new tree's version, if any.
    await fs.promises.rm(`${to}.boundary-fresh`, { recursive: true, force: true });
    return;
  }
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  let fresh: string | null = null;
  if (exists(to)) {
    fresh = `${to}.boundary-fresh`;
    await fs.promises.rm(fresh, { recursive: true, force: true });
    await fs.promises.rename(to, fresh);
  }
  await fs.promises.rename(from, to);
  undo?.push(() => fs.promises.rename(to, from));
  if (fresh) {
    const fromIsDir = fs.lstatSync(to).isDirectory();
    if (fromIsDir && fs.lstatSync(fresh).isDirectory()) {
      // Undoing removes the new tree's files again, so the old tree goes back as it was.
      const added = pathsOnlyIn(fresh, to);
      undo?.push(async () => {
        for (const p of added) await fs.promises.rm(p, { recursive: true, force: true });
      });
      await fs.promises.cp(fresh, to, { recursive: true, force: false, errorOnExist: false });
    }
    await fs.promises.rm(fresh, { recursive: true, force: true });
  }
}

/**
 * Finish a swap whose journal exists: carry preserved paths from the old tree into the
 * new one, then put the new tree in place. Safe to run again after a crash at any step:
 * each move happens once, and a path already moved is skipped.
 */
export async function completeProjectSwap(paths: ProjectSwapPaths): Promise<void> {
  await finishSwap(paths);
}

async function finishSwap(paths: ProjectSwapPaths, undo?: UndoStep[]): Promise<void> {
  const { projectRoot, nextRoot, previousRoot, journalPath } = paths;
  if (exists(nextRoot)) {
    for (const rel of PRESERVED_PROJECT_PATHS) {
      await carryOver(path.join(previousRoot, rel), path.join(nextRoot, rel), undo);
    }
    if (!exists(projectRoot)) {
      await fs.promises.rename(nextRoot, projectRoot);
      undo?.push(() => fs.promises.rename(projectRoot, nextRoot));
    }
  } else if (!exists(projectRoot) && exists(previousRoot)) {
    // The new tree is gone (e.g. temp cleanup). Put the old one back rather than lose it.
    await fs.promises.rename(previousRoot, projectRoot);
  }
  await fs.promises.rm(journalPath, { force: true });
}

/**
 * Replace the stack tree with `nextRoot` and keep the user's data and secrets.
 * The old tree is kept at `previousRoot` (code only, once its data has moved) until the
 * next upgrade, so nothing outside {@link PRESERVED_PROJECT_PATHS} is lost either.
 *
 * If a step fails, every move made so far is undone and the live tree is back as it was.
 * If undoing fails too, the journal and `nextRoot` stay so the next launch can finish the
 * swap; the caller must not delete `nextRoot` while the journal exists.
 */
export async function swapProjectTreePreservingData(paths: ProjectSwapPaths): Promise<void> {
  const { projectRoot, previousRoot, journalPath } = paths;
  // The tree kept from the last upgrade holds only stack code by now.
  await fs.promises.rm(previousRoot, { recursive: true, force: true });
  const undo: UndoStep[] = [];
  try {
    await fs.promises.writeFile(journalPath, `${JSON.stringify(paths, null, 2)}\n`, 'utf8');
    if (exists(projectRoot)) {
      await fs.promises.rename(projectRoot, previousRoot);
      undo.push(() => fs.promises.rename(previousRoot, projectRoot));
    }
    await finishSwap(paths, undo);
  } catch (error) {
    try {
      for (const step of undo.reverse()) await step();
      await fs.promises.rm(journalPath, { force: true });
    } catch (undoError) {
      const message = error instanceof Error ? error.message : String(error);
      const undoMessage = undoError instanceof Error ? undoError.message : String(undoError);
      throw new Error(
        `${message} (${APP_NAME} couldn’t undo the partial upgrade: ${undoMessage}. ` +
          'It will finish the upgrade on the next launch; your data is still on disk.)',
        { cause: undoError }
      );
    }
    throw error;
  }
}

/** If a swap was interrupted, finish it. Returns true when there was one to finish. */
export async function recoverInterruptedProjectSwap(journalPath: string): Promise<boolean> {
  if (!exists(journalPath)) return false;
  let paths: ProjectSwapPaths;
  try {
    paths = JSON.parse(await fs.promises.readFile(journalPath, 'utf8')) as ProjectSwapPaths;
  } catch {
    // Unreadable journal: leave every tree where it is for a person to look at.
    throw new Error(
      `${APP_NAME} couldn’t read its agent stack upgrade record (${journalPath}). ` +
        'Your data is still on disk. Remove that file after checking the assistant-stack folder.'
    );
  }
  if (!paths?.projectRoot || !paths.nextRoot || !paths.previousRoot) {
    throw new Error(`${APP_NAME}’s agent stack upgrade record is incomplete (${journalPath}).`);
  }
  await completeProjectSwap({ ...paths, journalPath });
  return true;
}
