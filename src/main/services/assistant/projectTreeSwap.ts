import fs from 'node:fs';
import path from 'node:path';

/**
 * Paths inside the agent-stack tree that hold the user's data or secrets generated on
 * this machine. Everything else in the tree comes from the stack archive and is replaced
 * when Boundary moves to a new pinned ref.
 *
 * Keep in sync with the stack's .gitignore (local runtime, secrets, generated overlays).
 */
export const PRESERVED_PROJECT_PATHS: readonly string[] = [
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

/**
 * Move one preserved path from the old tree into the new one. A directory is moved
 * whole, then anything only the new tree had (e.g. a tracked .gitkeep) is copied in
 * without overwriting.
 */
async function carryOver(from: string, to: string): Promise<void> {
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
  if (fresh) {
    const fromIsDir = fs.lstatSync(to).isDirectory();
    if (fromIsDir && fs.lstatSync(fresh).isDirectory()) {
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
  const { projectRoot, nextRoot, previousRoot, journalPath } = paths;
  if (exists(nextRoot)) {
    for (const rel of PRESERVED_PROJECT_PATHS) {
      await carryOver(path.join(previousRoot, rel), path.join(nextRoot, rel));
    }
    if (!exists(projectRoot)) {
      await fs.promises.rename(nextRoot, projectRoot);
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
 */
export async function swapProjectTreePreservingData(paths: ProjectSwapPaths): Promise<void> {
  const { projectRoot, previousRoot, journalPath } = paths;
  // The tree kept from the last upgrade holds only stack code by now.
  await fs.promises.rm(previousRoot, { recursive: true, force: true });
  await fs.promises.writeFile(journalPath, `${JSON.stringify(paths, null, 2)}\n`, 'utf8');
  if (exists(projectRoot)) {
    await fs.promises.rename(projectRoot, previousRoot);
  }
  await completeProjectSwap(paths);
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
      `Boundary couldn’t read its agent stack upgrade record (${journalPath}). ` +
        'Your data is still on disk. Remove that file after checking the assistant-stack folder.'
    );
  }
  if (!paths?.projectRoot || !paths.nextRoot || !paths.previousRoot) {
    throw new Error(`Boundary’s agent stack upgrade record is incomplete (${journalPath}).`);
  }
  await completeProjectSwap({ ...paths, journalPath });
  return true;
}
