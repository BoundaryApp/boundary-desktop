import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import { stackCapabilityRefusal } from '../../stackHost/capabilities';
import { getStoredHermesProject } from './hermesProjectStore';

/**
 * The stored project behind an action that works in its folder on this machine, or the error to
 * return: the hostFolders refusal when the stack host can't use folders here, else not found.
 */
export function hostFolderProject(
  projectId: string
): { project: HermesProjectRecord; error?: undefined } | { project?: undefined; error: string } {
  const refusal = stackCapabilityRefusal('hostFolders');
  if (refusal) return { error: refusal };
  const project = getStoredHermesProject(projectId);
  return project ? { project } : { error: 'Project not found.' };
}
