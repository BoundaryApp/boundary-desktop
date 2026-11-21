import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchAppCommand } from '../../useAppShortcuts';
import { INSPECTOR_OPEN_STORAGE_KEY } from '../inspectorOpenPref';
import {
  inspectSources,
  renderScreen,
  setInspectorBeside,
  setUpScreen,
  startInspectorClosed,
  tearDownScreen,
} from './workbenchChatScreenHarness';

vi.mock('../HermesChatRuntimeProvider', () => import('./workbenchChatScreenMocks'));
vi.mock('../WorkbenchThread', () => import('./workbenchChatScreenMocks'));

const details = () => screen.queryByRole('complementary', { name: 'Details' });
const stored = () => window.localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY);
const selectedTab = () =>
  within(details()!)
    .getAllByRole('button')
    .find((button) => button.classList.contains('is-on'))?.textContent;

/** The Project tab's fixture with one extra folder the agent can't see. */
function withUnmountedExtra() {
  inspectSources.mockResolvedValue({
    success: true,
    inspect: {
      projectId: 'p1',
      registryExists: true,
      stale: false,
      sources: [
        {
          id: 'project',
          path: '.',
          hostPath: '/Users/ada/Documents/Job Search',
          retrieval: 'files',
          visibility: 'hub',
          isHub: true,
        },
        {
          id: 'notes-vault',
          path: '/Users/ada/Notes/this-project',
          hostPath: '/Users/ada/Notes/this-project',
          retrieval: 'files',
          visibility: 'unmounted',
          isHub: false,
        },
      ],
      index: [],
    },
  });
}

describe('The inspector starts closed and opens on request (ADR 0069)', () => {
  beforeEach(setUpScreen);
  afterEach(tearDownScreen);

  it('starts closed on a fresh install, and the header toggle opens it and remembers that', async () => {
    startInspectorClosed();
    await renderScreen();

    expect(details()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));

    expect(details()).toBeTruthy();
    expect(stored()).toBe('open');
    expect(screen.getAllByRole('button', { name: 'Hide details' })[0]).toBeTruthy();
  });

  it('keeps open or closed when the conversation changes', async () => {
    await renderScreen();
    expect(details()).toBeTruthy();

    act(() => dispatchAppCommand('next-thread'));
    await waitFor(() => expect(screen.getByText(/thread:Resume summary/)).toBeTruthy());
    expect(details()).toBeTruthy();

    fireEvent.click(within(details()!).getByRole('button', { name: 'Hide details' }));
    expect(details()).toBeNull();
    expect(stored()).toBe('closed');

    act(() => dispatchAppCommand('prev-thread'));
    await waitFor(() => expect(screen.getByText(/thread:Plan the launch/)).toBeTruthy());
    expect(details()).toBeNull();
  });

  it('opens and closes with the Toggle Details command (⌥⌘0)', async () => {
    startInspectorClosed();
    await renderScreen();

    act(() => dispatchAppCommand('toggle-inspector'));
    expect(details()).toBeTruthy();
    act(() => dispatchAppCommand('toggle-inspector'));
    expect(details()).toBeNull();
  });

  it('opens on the Check tab when a reply is sent to it', async () => {
    startInspectorClosed();
    await renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'Check writing' }));

    await waitFor(() => expect(details()).toBeTruthy());
    expect(selectedTab()).toBe('Check');
  });

  it('shows a source warning on the toggle and opens on its banner', async () => {
    startInspectorClosed();
    withUnmountedExtra();
    await renderScreen();

    const toggle = await screen.findByRole('button', {
      name: 'Show details: notes-vault isn’t visible yet.',
    });
    expect(toggle.querySelector('.wb-insp-toggle-dot')).toBeTruthy();

    fireEvent.click(toggle);

    expect(selectedTab()).toBe('Project');
    expect(within(details()!).getByText('notes-vault isn’t visible yet.')).toBeTruthy();
  });

  describe('below 1280px', () => {
    beforeEach(() => setInspectorBeside(false));

    it('starts closed whatever is stored, overlays the center pane, and Escape closes it', async () => {
      await renderScreen();
      expect(stored()).toBe('open');
      expect(details()).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
      expect(details()!.classList.contains('is-overlay')).toBe(true);
      expect(document.querySelector('.wb-insp-scrim')).toBeTruthy();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(details()).toBeNull();
      expect(stored()).toBe('open');
    });

    it('closes again when another conversation opens', async () => {
      await renderScreen();
      fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
      expect(details()).toBeTruthy();

      act(() => dispatchAppCommand('next-thread'));
      await waitFor(() => expect(screen.getByText(/thread:Resume summary/)).toBeTruthy());
      expect(details()).toBeNull();
    });

    it('closes when the scrim is clicked', async () => {
      await renderScreen();
      fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
      fireEvent.click(document.querySelector('.wb-insp-scrim')!);
      expect(details()).toBeNull();
    });
  });
});
