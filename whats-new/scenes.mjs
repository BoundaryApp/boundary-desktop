/** Scenes for the public release notes in this folder. Shared scenes live in scripts/release-notes-shots. */
export const SCENES = {
  // The details panel starts closed, so these open it first. The harness answers inspectRemove
  // with a Boundary-made folder holding two commits only on this Mac, so the sheet shows the
  // Trash case and its warning.
  'remove-project': {
    view: 'chat',
    steps: [
      { clickLabel: 'Show details' },
      { wait: 300 },
      { clickText: 'Project' },
      { wait: 300 },
      { clickLabel: 'Project actions' },
      { wait: 300 },
      { clickText: 'Remove project…' },
      { wait: 500 },
    ],
  },
  'project-menu': {
    view: 'chat',
    steps: [
      { clickLabel: 'Show details' },
      { wait: 300 },
      { clickText: 'Project' },
      { wait: 300 },
      { clickLabel: 'Project actions' },
      { wait: 300 },
      { press: 'ArrowDown' },
      { press: 'ArrowDown' },
      { wait: 300 },
    ],
  },
  'bitwarden-page': {
    view: 'services',
    query: 'addon=bitwarden',
    steps: [{ clickText: 'Bitwarden' }, { wait: 500 }],
  },
  // Chat history after an export, scrolled into view on Settings → General.
  'export-history': {
    view: 'settings',
    query: 'history=exported',
    steps: [{ scrollText: 'Import history…' }, { wait: 300 }],
  },
  // The chat inspector starts closed (ADR 0069); the screenshot's context is fresh, so nothing
  // stored opens it.
  'inspector-closed': { view: 'chat', steps: [{ wait: 500 }] },
};
