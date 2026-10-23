import { describe, expect, it } from 'vitest';
import type { CodingGrantRow } from '../../../../shared/types/codingFolders';
import type { HermesProjectRecord, HermesSourceRow } from '../../../../shared/types/hermesChat';
import { checklistStepFor, folderRowView, grantFor } from '../codingFolderView';

const project: HermesProjectRecord = {
  id: 'p1',
  name: 'Portfolio',
  hostPath: '/Users/ada/Projects/portfolio',
  containerPath: '/opt/projects/portfolio',
  slug: 'portfolio',
  kind: 'host-folder',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const hub: HermesSourceRow = {
  id: 'project',
  path: '.',
  hostPath: project.hostPath,
  retrieval: 'files',
  visibility: 'hub',
  isHub: true,
};

function extra(visibility: HermesSourceRow['visibility'], hostPath = '/Users/ada/Code/tokens') {
  return { id: 'tokens', path: hostPath, hostPath, retrieval: 'files', visibility, isHub: false } as HermesSourceRow;
}

function grant(partial: Partial<CodingGrantRow> = {}): CodingGrantRow {
  return {
    capability: 'coding',
    resource: '/Users/ada/Code/tokens',
    createdAt: '2026-10-07T00:00:00.000Z',
    expiresAt: null,
    projectId: 'p1',
    origin: 'add',
    createdByBoundary: false,
    state: 'ready',
    hermesPending: false,
    ...partial,
  };
}

const none = { grants: [], pending: {}, managed: true };

describe('folderRowView', () => {
  it('offers Allow coding on a host-folder project folder without coding', () => {
    const view = folderRowView(hub, project, none);
    expect(view.pill).toEqual({ label: 'Hub', tone: 'ok' });
    expect(view.who).toBe('Hermes can edit · coding agent can’t');
    expect(view.canAllowCoding).toBe(true);
  });

  it('does not offer Allow coding when the stack is not managed, or for an empty project', () => {
    expect(folderRowView(hub, project, { ...none, managed: false }).canAllowCoding).toBe(false);
    expect(folderRowView(hub, { ...project, kind: 'empty' }, none).canAllowCoding).toBe(false);
  });

  it('shows the project folder as Coding once allowed', () => {
    const view = folderRowView(hub, { ...project, codingEnabled: true }, none);
    expect(view.pill).toEqual({ label: 'Coding', tone: 'code' });
    expect(view.who).toBe('Hermes and the coding agent can edit');
    expect(view.canAllowCoding).toBe(false);
  });

  it('shows a project folder the coding agent cannot open', () => {
    const view = folderRowView(hub, { ...project, codingEnabled: true }, {
      ...none,
      grants: [grant({ resource: project.hostPath, origin: 'project-folder', state: 'not-visible' })],
    });
    expect(view.pill.label).toBe('Not visible');
    expect(view.notVisible).toBe(true);
  });

  it('shows Connecting and Queued while a change runs or waits', () => {
    expect(
      folderRowView(extra('unmounted'), project, {
        ...none,
        pending: { '/Users/ada/Code/tokens': 'connecting' },
      }).pill
    ).toEqual({ label: 'Connecting', tone: 'busy' });
    expect(
      folderRowView(hub, project, { ...none, pending: { [project.hostPath]: 'queued' } }).pill
    ).toEqual({ label: 'Queued', tone: 'warn' });
  });

  it('shows a granted folder as Coding, with the Hermes wait when pending', () => {
    expect(folderRowView(extra('writable'), project, { ...none, grants: [grant()] }).who).toBe(
      'Hermes and the coding agent can edit'
    );
    const pending = folderRowView(extra('writable'), project, {
      ...none,
      grants: [grant({ hermesPending: true })],
    });
    expect(pending.pill).toEqual({ label: 'Coding', tone: 'code' });
    expect(pending.who).toBe('Coding agent can edit · Hermes after its next restart');
    expect(pending.hermesPending).toBe(true);
  });

  it('shows a granted folder the coding agent cannot open', () => {
    const view = folderRowView(extra('writable'), project, {
      ...none,
      grants: [grant({ state: 'not-visible' })],
    });
    expect(view.pill).toEqual({ label: 'Not visible', tone: 'bad' });
    expect(view.coding).toBe(true);
  });

  it('keeps the 0013 states for folders that are not granted', () => {
    expect(folderRowView(extra('readonly'), project, none).pill).toEqual({
      label: 'Read-only',
      tone: 'ok',
    });
    expect(folderRowView(extra('writable'), project, none).pill).toEqual({
      label: 'Writable',
      tone: 'warn',
    });
    expect(folderRowView(extra('unmounted'), project, none).pill).toEqual({
      label: 'Not visible',
      tone: 'bad',
    });
  });
});

describe('grantFor', () => {
  it('matches a grant ignoring a trailing slash', () => {
    expect(grantFor('/Users/ada/Code/tokens/', [grant()])?.resource).toBe('/Users/ada/Code/tokens');
    expect(grantFor('/Users/ada/Code/token', [grant()])).toBeNull();
  });
});

describe('checklistStepFor', () => {
  it('maps main’s progress lines to checklist steps', () => {
    expect(checklistStepFor('Saving coding folders…')).toBe(0);
    expect(checklistStepFor('Restarting the coding agent…')).toBe(1);
    expect(checklistStepFor('Checking the coding agent can open each folder…')).toBe(2);
    expect(checklistStepFor('Something else')).toBeNull();
  });
});
