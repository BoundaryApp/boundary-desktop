import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedFolderListing } from '../../../../shared/types/sharedFolders';
import { ME, runningCircles } from '../../../__tests__/circleFixtures';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { CirclesRail } from '../../circles/CirclesRail';
import { CirclePlace } from '../circle/CirclePlace';
import { COVER, SAM, STUDIO, added, change, circle, offered } from './sharedFolderFixtures';

const NEW = 'ee'.repeat(32);

const circles = runningCircles({ displayName: 'Jordan', circles: [circle] });

const activity = [
  change({ seq: 9, by: ME, version: 2, confirmed: false }),
  change({ seq: 5, path: 'brief (conflict, Sam).md', conflictOf: 'brief.md' }),
];
// Newest first: current, one on this Mac, one only on Sam's (offline) Mac.
const versions = [
  change({ seq: 9, by: ME, version: 3, here: true }),
  change({ seq: 6, by: ME, version: 2, here: true }),
  change({ seq: 2, by: SAM, version: 1, here: false }),
];

let listing: SharedFolderListing[] = [];
let folderListeners: Array<(event: { key: string }) => void> = [];
const foldersList = vi.fn();
const folderAdd = vi.fn();
const folderShare = vi.fn();
const folderCheck = vi.fn();
const folderScan = vi.fn();
const folderRemove = vi.fn();
const folderFiles = vi.fn();
const folderReveal = vi.fn();
const folderHistory = vi.fn();
const folderRestore = vi.fn();
const folderCompare = vi.fn();
const folderResolve = vi.fn();
const folderSetRole = vi.fn();
const pickFolder = vi.fn();
const createHost = vi.fn();
const addSourceFolder = vi.fn();
const listProjects = vi.fn();
const viewing = vi.fn();

beforeEach(() => {
  listing = [];
  folderListeners = [];
  foldersList.mockReset().mockImplementation(async () => ({ success: true, state: circles, folders: listing }));
  folderAdd.mockReset().mockResolvedValue({ success: true, state: circles });
  folderShare.mockReset().mockResolvedValue({ success: true, state: circles, key: NEW, root: '/Users/jordan/Projects/spring-list' });
  folderCheck.mockReset().mockResolvedValue({ problem: null });
  folderScan.mockReset().mockResolvedValue({ files: 12, bytes: 3 * 1024 * 1024, unshared: [{ path: 'node_modules/', reason: 'never-shared' }], unsharedCount: 1, partial: false });
  folderRemove.mockReset().mockResolvedValue({ success: true, state: circles });
  folderFiles.mockReset().mockResolvedValue({
    success: true,
    state: circles,
    files: [{ path: 'brief.md', size: 1024, by: SAM, at: Date.UTC(2026, 10, 2, 10, 9), conflictOf: null }],
  });
  folderHistory.mockReset().mockImplementation(async ({ path }: { path?: string }) => ({
    success: true,
    state: circles,
    history: path ? versions : activity,
  }));
  folderRestore.mockReset().mockResolvedValue({ success: true, state: circles });
  folderCompare.mockReset().mockResolvedValue({
    success: true,
    state: circles,
    conflict: {
      original: change({ path: 'brief.md', by: ME, version: 4 }),
      copy: change({ path: 'brief (conflict, Sam).md', by: SAM, conflictOf: 'brief.md' }),
      texts: ['Title\nThree options', 'Title\nTwo options'],
    },
  });
  folderResolve.mockReset().mockResolvedValue({ success: true, state: circles });
  folderSetRole.mockReset().mockResolvedValue({ success: true, state: circles });
  folderReveal.mockReset().mockResolvedValue({ success: true, state: circles });
  pickFolder.mockReset().mockResolvedValue({ success: true, hostPath: '/Users/jordan/Projects/spring-list' });
  createHost.mockReset().mockResolvedValue({ success: true, project: { id: 'p-cover' } });
  addSourceFolder.mockReset().mockResolvedValue({ success: true });
  listProjects.mockReset().mockResolvedValue({ success: true, activeId: null, projects: [{ id: 'p-book', name: 'Book' }, { id: 'p-site', name: 'Site' }] });
  viewing.mockReset().mockResolvedValue(undefined);
  stubElectronAPI({
    circles: {
      viewing,
      foldersList,
      folderAdd,
      folderShare,
      folderCheck,
      folderScan,
      folderRemove,
      folderFiles,
      folderReveal,
      folderHistory,
      folderRestore,
      folderCompare,
      folderResolve,
      folderSetRole,
      folderDefaultRoot: async ({ circle: c, name }: { circle: string; name: string }) => `/Users/jordan/Circles/${c}/${name}`,
      onFolderChanged: (listener: (event: { key: string }) => void) => {
        folderListeners.push(listener);
        return () => {
          folderListeners = folderListeners.filter((item) => item !== listener);
        };
      },
    },
    projects: { pickFolder, createHost, addSourceFolder, list: listProjects },
  });
});

afterEach(cleanup);

const onOpenProject = vi.fn();
/** The screen's part: a rail with a slot for the Circle's area, and the place that draws into it. */
const Host: React.FC = () => {
  const [slot, setSlot] = React.useState<HTMLElement | null>(null);
  return (
    <>
      <CirclesRail area={<div ref={setSlot} className="wb-circle-area-slot" />} dock={null} />
      <CirclePlace
        circle={circle}
        circles={circles}
        channels={undefined}
        channelId="general"
        onOpenChannel={() => {}}
        areaSlot={slot}
        onOpenProject={onOpenProject}
      />
    </>
  );
};
const mount = () => render(<Host />);
const rail = () => screen.getByRole('complementary', { name: 'Circles' });

describe('the Folders section of a Circle', () => {
  it('stops reporting the channel as viewed while a folder fills the centre, and reports it again after', async () => {
    listing = [added()];
    mount();
    await waitFor(() => expect(viewing).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'general' })));
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    await waitFor(() => expect(viewing).toHaveBeenLastCalledWith(null));
    fireEvent.click(within(rail()).getByRole('button', { name: /General/ }));
    await waitFor(() => expect(viewing).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'general' })));
  });

  it('offers to share a folder when the Circle has none', async () => {
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: 'Share a folder…' }));
    expect(screen.getByRole('dialog', { name: 'Share a folder with Studio' })).toBeTruthy();
  });

  it('lists an offered folder as not added, and nothing downloads until it is added', async () => {
    listing = [offered];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    expect(within(rail()).getByText('Not added')).toBeTruthy();
    expect(screen.getByText('Sam shared this folder with Studio.')).toBeTruthy();
    expect(folderAdd).not.toHaveBeenCalled();
    expect(folderFiles).not.toHaveBeenCalled();
  });
});

describe('adding a folder to this Mac', () => {
  it('adds it at the default location as a new project, then offers to open it', async () => {
    listing = [offered];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to this Mac…' }));
    const sheet = screen.getByRole('dialog', { name: 'Add Cover art to this Mac' });
    await waitFor(() => expect((within(sheet).getByLabelText('Location') as HTMLInputElement).value).toContain('Circles/Studio/Cover art'));
    expect(within(sheet).getByRole('radio', { name: /A new project named Cover art/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add and download 2 KB' }));
    await waitFor(() => expect(createHost).toHaveBeenCalledWith({ hostPath: '/Users/jordan/Circles/Studio/Cover art', name: 'Cover art' }));
    expect(folderAdd).toHaveBeenCalledWith({ circle: STUDIO, key: COVER, root: '/Users/jordan/Circles/Studio/Cover art' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open project' }));
    expect(onOpenProject).toHaveBeenCalledWith('p-cover');
  });

  it('makes no project when asked not to', async () => {
    listing = [offered];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to this Mac…' }));
    const sheet = screen.getByRole('dialog', { name: 'Add Cover art to this Mac' });
    fireEvent.click(within(sheet).getByRole('radio', { name: /No project for now/ }));
    await waitFor(() => expect(within(sheet).getByRole('button', { name: /Add and download/ }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(sheet).getByRole('button', { name: /Add and download/ }));
    await waitFor(() => expect(folderAdd).toHaveBeenCalled());
    expect(createHost).not.toHaveBeenCalled();
    expect(await screen.findByText(/Cover art is on this Mac/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open project' })).toBeNull();
  });
});

describe('adding a folder to an existing project', () => {
  it('adds it as a folder in the chosen project and offers to open that project', async () => {
    listing = [offered];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to this Mac…' }));
    const sheet = screen.getByRole('dialog', { name: 'Add Cover art to this Mac' });
    fireEvent.click(await within(sheet).findByRole('radio', { name: /An existing project/ }));
    fireEvent.change(within(sheet).getByLabelText('Project'), { target: { value: 'p-site' } });
    await waitFor(() => expect(within(sheet).getByRole('button', { name: /Add and download/ }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(sheet).getByRole('button', { name: /Add and download/ }));
    await waitFor(() => expect(addSourceFolder).toHaveBeenCalledWith({ projectId: 'p-site', hostPath: '/Users/jordan/Circles/Studio/Cover art' }));
    expect(createHost).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Open project' }));
    expect(onOpenProject).toHaveBeenCalledWith('p-site');
  });
});

describe('sharing a folder', () => {
  const openShare = async () => {
    listing = [added()];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: 'Share a folder' }));
    return screen.getByRole('dialog', { name: 'Share a folder with Studio' });
  };

  it('checks the folder, shows what members download and what stays, then shares it at the chosen role', async () => {
    const sheet = await openShare();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Choose folder…' }));
    await within(sheet).findByRole('heading', { name: 'Share spring-list' });
    expect(within(sheet).getByText('12 files, 3 MB')).toBeTruthy();
    expect(within(sheet).getByText('node_modules/')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Next' }));
    fireEvent.click(within(sheet).getByRole('radio', { name: /Only managers edit/ }));
    expect(within(sheet).getByText(/Changes confirm when you are online/)).toBeTruthy();
    // A long Circle name ends in an ellipsis instead of pushing the button past the sheet.
    const share = within(sheet).getByRole('button', { name: 'Share with Studio' });
    expect(share.className).toContain('max-w-full');
    expect(share.querySelector('span.truncate')?.textContent).toBe('Share with Studio');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Share with Studio' }));
    await waitFor(() =>
      expect(folderShare).toHaveBeenCalledWith({ key: STUDIO, name: 'spring-list', source: '/Users/jordan/Projects/spring-list', role: 'reader' })
    );
  });

  it('refuses a git repository before the People step', async () => {
    folderCheck.mockResolvedValue({ problem: { kind: 'git', message: 'This folder is a git repository.' } });
    const sheet = await openShare();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Choose folder…' }));
    await within(sheet).findByRole('heading', { name: 'spring-list can’t be shared' });
    expect(within(sheet).getByText('This folder is a git repository.')).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Next' })).toBeNull();
    expect(folderScan).not.toHaveBeenCalled();
  });

  it('shares a copy of a folder inside a sync tool', async () => {
    folderCheck.mockResolvedValue({ problem: { kind: 'sync-tool', tool: 'iCloud Drive', message: 'This folder is in iCloud Drive.' } });
    const sheet = await openShare();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Choose folder…' }));
    await within(sheet).findByRole('heading', { name: 'Share a copy of spring-list' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy and continue' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Share with Studio' }));
    await waitFor(() => expect(folderShare).toHaveBeenCalledWith(expect.objectContaining({ copy: true, role: 'editor' })));
  });

  it('starts an empty folder by name', async () => {
    const sheet = await openShare();
    fireEvent.click(within(sheet).getByRole('radio', { name: /Start an empty folder/ }));
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Spring catalogue' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Next' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Share with Studio' }));
    await waitFor(() => expect(folderShare).toHaveBeenCalledWith({ key: STUDIO, name: 'Spring catalogue', source: null, role: 'editor' }));
    expect(pickFolder).not.toHaveBeenCalled();
  });
});

describe('a folder on this Mac', () => {
  it('shows its files, what stays on this Mac, and reloads when the folder changes', async () => {
    listing = [added()];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    fireEvent.click(await screen.findByRole('tab', { name: /Files/ }));
    expect(await screen.findByRole('button', { name: 'brief.md' })).toBeTruthy();
    expect(screen.getByText('Up to date')).toBeTruthy();
    expect(screen.getByText('.env')).toBeTruthy();
    expect(screen.getByText('Shared by Sam · everyone can edit')).toBeTruthy();
    const calls = folderFiles.mock.calls.length;
    act(() => folderListeners.forEach((listener) => listener({ key: COVER })));
    await waitFor(() => expect(folderFiles.mock.calls.length).toBeGreaterThan(calls));
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
    expect(folderReveal).toHaveBeenCalledWith({ key: COVER });
  });

  it('tells a reader their copy is read-only', async () => {
    listing = [added({ role: 'reader', defaultRole: 'reader' })];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    expect(await screen.findByText('You can read Cover art')).toBeTruthy();
  });

  it('removes it and keeps the files unless asked', async () => {
    listing = [added()];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open folder details' }));
    const details = screen.getByRole('complementary', { name: 'Cover art details' });
    expect(within(details).getByText('Changes confirm when Sam is online. New members join as editors.')).toBeTruthy();
    fireEvent.click(within(details).getByRole('button', { name: 'Remove from this Mac…' }));
    const sheet = screen.getByRole('dialog', { name: 'Remove Cover art from this Mac?' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove from this Mac' }));
    await waitFor(() => expect(folderRemove).toHaveBeenCalledWith({ key: COVER, trash: false }));
  });
});

describe('following changes', () => {
  it('lists Activity newest first, marks unconfirmed changes, and says when a conflict was kept', async () => {
    listing = [added()];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    const list = await screen.findByRole('list', { name: 'Activity' });
    const items = within(list).getAllByRole('listitem').filter((item) => item.className.includes('wb-folder-act'));
    expect(items[0].textContent).toContain('You changed brief.md');
    expect(items[0].textContent).toContain('waiting for a manager');
    expect(items[1].textContent).toContain('Sam’s edit to brief.md crossed another. Kept as brief (conflict, Sam).md');
  });

  it('opens a file’s history, restores an older version, and can’t restore one only on an offline Mac', async () => {
    listing = [added()];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    const list = await screen.findByRole('list', { name: 'Activity' });
    fireEvent.click(within(list).getAllByRole('button', { name: 'brief.md' })[0]);
    const pane = await screen.findByRole('complementary', { name: 'brief.md history' });
    await within(pane).findByText('Current');
    const restores = within(pane).getAllByRole('button', { name: 'Restore' });
    expect(restores).toHaveLength(1);
    expect(within(pane).getByText(/Sam’s Mac, which wrote it, is offline/)).toBeTruthy();
    fireEvent.click(restores[0]);
    await waitFor(() => expect(folderRestore).toHaveBeenCalledWith({ key: COVER, path: 'brief.md', seq: 6 }));
  });

  it('tells a reader nothing can be restored', async () => {
    listing = [added({ role: 'reader', writable: false })];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    fireEvent.click(within(await screen.findByRole('list', { name: 'Activity' })).getAllByRole('button', { name: 'brief.md' })[0]);
    const pane = await screen.findByRole('complementary', { name: 'brief.md history' });
    await within(pane).findByText('Current');
    expect(within(pane).queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('names the managers changes wait for when too few are online', async () => {
    listing = [added({ unconfirmed: 2 })];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    expect(await screen.findByText('2 changes are waiting for Sam')).toBeTruthy();
  });
});

describe('conflicts', () => {
  it('shows the conflict in the strip and settles it with the side picked', async () => {
    listing = [added({ conflicts: ['brief (conflict, Sam).md'] })];
    mount();
    expect(await within(rail()).findByRole('img', { name: 'Conflict' })).toBeTruthy();
    fireEvent.click(within(rail()).getByRole('button', { name: /Cover art/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    const sheet = await screen.findByRole('dialog', { name: 'brief.md: two edits crossed' });
    expect(within(sheet).getByLabelText('Sam’s version').textContent).toContain('Two options');
    expect(within(sheet).getByText('Three options').className).toBe('is-changed');
    // A long member name ends in an ellipsis instead of pushing the buttons past the sheet.
    for (const name of ['Keep Sam’s', 'Keep yours']) {
      const keep = within(sheet).getByRole('button', { name });
      expect(keep.className).toContain('max-w-full');
      expect(keep.querySelector('span.truncate')?.textContent).toBe(name);
    }
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Keep Sam’s' }));
    await waitFor(() => expect(folderResolve).toHaveBeenCalledWith({ key: COVER, copy: 'brief (conflict, Sam).md', keep: 'copy' }));
    expect(within(sheet).getByRole('button', { name: 'Keep yours' })).toBeTruthy();
  });
});

describe('roles', () => {
  it('lets a manager change a role, including for someone who hasn’t added the folder', async () => {
    listing = [
      added({
        role: 'manager',
        people: [{ identity: ME, name: 'Jordan', role: 'manager' }],
      }),
    ];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open folder details' }));
    const details = screen.getByRole('complementary', { name: 'Cover art details' });
    fireEvent.click(within(details).getByRole('button', { name: 'Change roles' }));
    expect(within(details).getByText(/Hasn’t added it/)).toBeTruthy();
    fireEvent.change(within(details).getByLabelText('Sam’s role'), { target: { value: 'manager' } });
    await waitFor(() => expect(folderSetRole).toHaveBeenCalledWith({ key: COVER, identity: SAM, role: 'manager', name: 'Sam' }));
  });

  it('doesn’t offer Change roles to an editor', async () => {
    listing = [added()];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: /Cover art/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open folder details' }));
    expect(within(screen.getByRole('complementary', { name: 'Cover art details' })).queryByRole('button', { name: 'Change roles' })).toBeNull();
  });

  it('shares with chosen managers and says how many must confirm', async () => {
    listing = [added()];
    mount();
    fireEvent.click(await within(rail()).findByRole('button', { name: 'Share a folder' }));
    const sheet = screen.getByRole('dialog', { name: 'Share a folder with Studio' });
    fireEvent.click(within(sheet).getByRole('radio', { name: /Start an empty folder/ }));
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Notes' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Next' }));
    fireEvent.click(within(sheet).getByRole('checkbox', { name: /Sam/ }));
    expect(within(sheet).getByText(/2 managers: changes confirm when both have seen them\. Two managers make every change wait for both/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Share with Studio' }));
    await waitFor(() =>
      expect(folderShare).toHaveBeenCalledWith(expect.objectContaining({ name: 'Notes', managers: [{ identity: SAM, name: 'Sam' }] }))
    );
  });
});
