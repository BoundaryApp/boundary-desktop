import type { CodingGrantRow } from '../../../shared/types/codingFolders';
import type { HermesProjectRecord, HermesSourceRow } from '../../../shared/types/hermesChat';

/**
 * How a Folders row reads in the Project tab (ADR 0028 §1). One pill word plus a line that
 * says who can do what. Pure, so every state is tested without the IPC layer.
 */

export type FolderPillTone = 'ok' | 'warn' | 'bad' | 'code' | 'busy';

export type CodingPending = 'connecting' | 'queued';

export interface FolderRowView {
  pill: { label: string; tone: FolderPillTone };
  who: string;
  /** The coding agent may work here (granted, even if not yet visible). */
  coding: boolean;
  /** Granted but the coding agent can't open it. */
  notVisible: boolean;
  /** Hermes's own edits wait for its next restart. */
  hermesPending: boolean;
  /** The project's own folder can be offered "Allow coding…". */
  canAllowCoding: boolean;
}

export function folderKey(hostPath: string): string {
  return hostPath.length > 1 ? hostPath.replace(/\/+$/, '') : hostPath;
}

export function grantFor(
  hostPath: string,
  grants: readonly CodingGrantRow[]
): CodingGrantRow | null {
  const key = folderKey(hostPath);
  return grants.find((grant) => folderKey(grant.resource) === key) ?? null;
}

function pendingView(kind: CodingPending): Pick<FolderRowView, 'pill' | 'who'> {
  return kind === 'connecting'
    ? {
        pill: { label: 'Connecting', tone: 'busy' },
        who: 'Restarting the coding agent…',
      }
    : {
        pill: { label: 'Queued', tone: 'warn' },
        who: 'Waits for the running coding task to finish',
      };
}

export function folderRowView(
  row: HermesSourceRow,
  project: HermesProjectRecord,
  options: {
    grants: readonly CodingGrantRow[];
    pending: Readonly<Record<string, CodingPending>>;
    managed: boolean;
  }
): FolderRowView {
  const key = folderKey(row.hostPath);
  const pending = options.pending[key];
  const grant = grantFor(row.hostPath, options.grants);
  const base: FolderRowView = {
    pill: { label: 'Hub', tone: 'ok' },
    who: '',
    coding: false,
    notVisible: false,
    hermesPending: false,
    canAllowCoding: false,
  };

  if (row.isHub) {
    if (pending) return { ...base, ...pendingView(pending), coding: true };
    if (project.codingEnabled) {
      if (grant?.state === 'not-visible') {
        return {
          ...base,
          pill: { label: 'Not visible', tone: 'bad' },
          who: 'The coding agent can’t open this folder',
          coding: true,
          notVisible: true,
        };
      }
      return {
        ...base,
        pill: { label: 'Coding', tone: 'code' },
        who: 'Hermes and the coding agent can edit',
        coding: true,
      };
    }
    const canAllowCoding = options.managed && project.kind === 'host-folder';
    return {
      ...base,
      who: canAllowCoding ? 'Hermes can edit · coding agent can’t' : 'Hermes can edit',
      canAllowCoding,
    };
  }

  if (pending) return { ...base, ...pendingView(pending), coding: true };
  if (grant) {
    if (grant.state === 'not-visible') {
      return {
        ...base,
        pill: { label: 'Not visible', tone: 'bad' },
        who: 'Saved, but the coding agent can’t open it',
        coding: true,
        notVisible: true,
      };
    }
    return {
      ...base,
      pill: { label: 'Coding', tone: 'code' },
      who: grant.hermesPending
        ? 'Coding agent can edit · Hermes after its next restart'
        : 'Hermes and the coding agent can edit',
      coding: true,
      hermesPending: grant.hermesPending,
    };
  }
  switch (row.visibility) {
    case 'readonly':
      return {
        ...base,
        pill: { label: 'Read-only', tone: 'ok' },
        who: 'Hermes can read',
      };
    case 'writable':
      return {
        ...base,
        pill: { label: 'Writable', tone: 'warn' },
        who: 'Inside a coding folder, so agents can edit it',
      };
    case 'unmounted':
      return {
        ...base,
        pill: { label: 'Not visible', tone: 'bad' },
        who: 'Saved, not visible to agents yet',
      };
    case 'hub':
      return { ...base, who: 'Hermes can edit' };
  }
}

/** The Connecting checklist step for a progress line from main. */
export function checklistStepFor(message: string): 0 | 1 | 2 | null {
  if (/^Saving/i.test(message)) return 0;
  if (/^Restarting/i.test(message)) return 1;
  if (/^Checking/i.test(message)) return 2;
  return null;
}
