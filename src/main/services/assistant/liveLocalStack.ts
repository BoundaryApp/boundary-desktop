import fs from 'node:fs';
import path from 'node:path';
import { BOUNDARY_ASSISTANT_PROJECT_NAME } from '../../../shared/assistantStackConstants';

const PROJECT_LABEL = 'com.docker.compose.project';
const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';

/** `docker ps` format that prints each running container's Compose project and directory. */
export const LIVE_STACK_PS_ARGS = [
  'ps',
  '--format',
  `{{.Label "${PROJECT_LABEL}"}}\t{{.Label "${WORKING_DIR_LABEL}"}}`,
];

function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Compose projects other than Boundary's own that have running containers started from
 * `root` (a developer's `make up` in the local checkout). Their containers hold the stack's
 * host ports, so starting `boundary-assistant` beside them fails with "port is already
 * allocated". Takes the output of `docker ps` with {@link LIVE_STACK_PS_ARGS}.
 */
export function liveForeignProjectsAt(root: string, psStdout: string): string[] {
  const target = canonicalPath(root);
  const projects = new Set<string>();
  for (const line of psStdout.split('\n')) {
    const [project, workingDir] = line.trim().split('\t');
    if (!project || !workingDir || project === BOUNDARY_ASSISTANT_PROJECT_NAME) continue;
    if (canonicalPath(workingDir) === target) projects.add(project);
  }
  return [...projects].sort();
}
