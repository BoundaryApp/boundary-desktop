import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { clearChatScreenSnapshot } from '../chatScreenCache';
import { resetCodingFoldersStoreForTests } from '../codingFoldersStore';
import { INSPECTOR_OPEN_STORAGE_KEY, INSPECTOR_SIDE_QUERY } from '../inspectorOpenPref';
import { resetKeptWritableForTests } from '../projectSourceWarnings';
import { WorkbenchChatScreen } from '../WorkbenchChatScreen';
import * as ipcCalls from './ipcCalls';

/**
 * Main for WorkbenchChatScreen's tests: a mock per bridge call the screen makes, the defaults
 * each test starts from (`setUpScreen`), and the screen rendered once its first loads are in.
 * Each test file mocks the thread and runtime with `workbenchChatScreenMocks`.
 */

ipcCalls.settleBeforeWaits();

const listThreads = vi.fn();
const listProjects = vi.fn();
const inspectSources = vi.fn();
const addSourceFolder = vi.fn();
const pickCodingFolder = vi.fn();
const grantCodingFolder = vi.fn();
const removeSource = vi.fn();
const revealSource = vi.fn();
const refreshIndex = vi.fn();
const createHostProject = vi.fn();
const changeFolder = vi.fn();
const inspectRemoveProject = vi.fn();
const removeProject = vi.fn();
const selectProject = vi.fn();
const listAgents = vi.fn();
const createHermesChat = vi.fn();
const openAgentDm = vi.fn();
const createAgent = vi.fn();
const updateAgent = vi.fn();
const listChannels = vi.fn();
const createChannel = vi.fn();
const addChannelMember = vi.fn();
const renameChannel = vi.fn();
const deleteChannel = vi.fn();
const deleteFailedChat = vi.fn();
const makeChannelFromHermesChat = vi.fn();
const setLastOpened = vi.fn();
const createEmptyProject = vi.fn();
const listMentions = vi.fn();
const markMentionsSeen = vi.fn();
const moveToProject = vi.fn();
const undoProjectMove = vi.fn();
const listProjectMarks = vi.fn();
const countProjectSources = vi.fn();
const sessionsChanged = new Set<() => void>();

stubElectronAPI({
  onboarding: {
    getStatus: ipcCalls.track(vi.fn().mockResolvedValue({ configured: true, slots: {} })),
    probeSlotHealth: ipcCalls.track(vi.fn().mockResolvedValue({ success: true })),
  },
  hermesChat: {
    listThreads: ipcCalls.track((...args: unknown[]) => listThreads(...args)),
    createHermesChat: ipcCalls.track((...args: unknown[]) => createHermesChat(...args)),
    deleteFailedChat: ipcCalls.track((...args: unknown[]) => deleteFailedChat(...args)),
    openAgentDm: ipcCalls.track((...args: unknown[]) => openAgentDm(...args)),
    onSessionsChanged: (cb: () => void) => {
      sessionsChanged.add(cb);
      return () => sessionsChanged.delete(cb);
    },
    listMentions: ipcCalls.track((...args: unknown[]) => listMentions(...args)),
    markMentionsSeen: ipcCalls.track((...args: unknown[]) => markMentionsSeen(...args)),
    moveToProject: ipcCalls.track((...args: unknown[]) => moveToProject(...args)),
    undoProjectMove: ipcCalls.track((...args: unknown[]) => undoProjectMove(...args)),
    listProjectMarks: ipcCalls.track((...args: unknown[]) => listProjectMarks(...args)),
    getSessionInference: ipcCalls.track(
      vi.fn().mockResolvedValue({ success: true, override: null, marks: [] })
    ),
  },
  projects: {
    list: ipcCalls.track((...args: unknown[]) => listProjects(...args)),
    select: ipcCalls.track((...args: unknown[]) => selectProject(...args)),
    pickFolder: vi.fn(),
    createEmpty: ipcCalls.track((...args: unknown[]) => createEmptyProject(...args)),
    createHost: ipcCalls.track((...args: unknown[]) => createHostProject(...args)),
    changeFolder: ipcCalls.track((...args: unknown[]) => changeFolder(...args)),
    inspectRemove: ipcCalls.track((...args: unknown[]) => inspectRemoveProject(...args)),
    remove: ipcCalls.track((...args: unknown[]) => removeProject(...args)),
    reveal: vi.fn(),
    inspectSources: ipcCalls.track((...args: unknown[]) => inspectSources(...args)),
    addSourceFolder: ipcCalls.track((...args: unknown[]) => addSourceFolder(...args)),
    removeSource: ipcCalls.track((...args: unknown[]) => removeSource(...args)),
    revealSource: ipcCalls.track((...args: unknown[]) => revealSource(...args)),
    refreshIndex: ipcCalls.track((...args: unknown[]) => refreshIndex(...args)),
    countSources: ipcCalls.track((...args: unknown[]) => countProjectSources(...args)),
  },
  agents: {
    onChanged: () => () => {},
    list: ipcCalls.track((...args: unknown[]) => listAgents(...args)),
    create: ipcCalls.track((...args: unknown[]) => createAgent(...args)),
    update: ipcCalls.track((...args: unknown[]) => updateAgent(...args)),
    getSoul: ipcCalls.track(
      vi.fn().mockResolvedValue({ success: true, excerpt: null, canOpen: false })
    ),
    revealSoul: ipcCalls.track(vi.fn().mockResolvedValue({ success: true })),
  },
  channels: {
    list: ipcCalls.track((...args: unknown[]) => listChannels(...args)),
    create: ipcCalls.track((...args: unknown[]) => createChannel(...args)),
    addMember: ipcCalls.track((...args: unknown[]) => addChannelMember(...args)),
    rename: ipcCalls.track((...args: unknown[]) => renameChannel(...args)),
    remove: ipcCalls.track((...args: unknown[]) => deleteChannel(...args)),
    makeFromChat: ipcCalls.track((...args: unknown[]) =>
      makeChannelFromHermesChat(...args)
    ),
    setLastOpened: ipcCalls.track((...args: unknown[]) => setLastOpened(...args)),
  },
  codingFolders: {
    pick: ipcCalls.track((...args: unknown[]) => pickCodingFolder(...args)),
    grant: ipcCalls.track((...args: unknown[]) => grantCodingFolder(...args)),
    list: ipcCalls.track(
      vi.fn(async () => ({ success: true, managed: true, grants: [] }))
    ),
    busy: ipcCalls.track(vi.fn(async () => ({ busy: false, sessions: [] }))),
    onProgress: vi.fn(() => () => {}),
  },
});

/** The mocks above, which a test may give its own answers; `tearDownScreen` resets them. */
const screenMocks = [
  listThreads, listProjects, inspectSources, addSourceFolder, pickCodingFolder,
  grantCodingFolder, removeSource, revealSource, refreshIndex, createHostProject, changeFolder,
  inspectRemoveProject, removeProject,
  selectProject, listAgents, createHermesChat, openAgentDm, createAgent, updateAgent,
  listChannels, createChannel, addChannelMember, renameChannel, deleteChannel, deleteFailedChat,
  makeChannelFromHermesChat, setLastOpened, createEmptyProject, listMentions, markMentionsSeen,
  moveToProject, undoProjectMove, listProjectMarks, countProjectSources,
];

export {
  listThreads,
  listProjects,
  inspectSources,
  addSourceFolder,
  pickCodingFolder,
  grantCodingFolder,
  createHostProject,
  changeFolder,
  inspectRemoveProject,
  removeProject,
  selectProject,
  listAgents,
  createHermesChat,
  openAgentDm,
  createAgent,
  updateAgent,
  listChannels,
  renameChannel,
  deleteChannel,
  deleteFailedChat,
  setLastOpened,
  createEmptyProject,
  listMentions,
  markMentionsSeen,
  moveToProject,
  undoProjectMove,
  countProjectSources,
  sessionsChanged,
};

/** Renders the screen once its first loads (chats, projects, agents, folders) are in. */
export async function renderScreen() {
  render(<WorkbenchChatScreen />);
  await ipcCalls.settle();
}

/** One project with only its hub, two Hermes chats in it, and the built-in agent. */
export function setUpScreen() {
  clearChatScreenSnapshot();
  // Most tests work in the inspector, so they start with it open (ADR 0069 §2). Tests of the
  // closed default call `startInspectorClosed` after this.
  window.localStorage.setItem(INSPECTOR_OPEN_STORAGE_KEY, 'open');
  setInspectorBeside(true);
  listAgents.mockResolvedValue({
    success: true,
    agents: [
      {
        slug: 'assistant',
        displayName: 'Hermes',
        handle: 'Hermes',
        role: 'Default agent on this machine.',
        builtIn: true,
        createdAt: '1970-01-01T00:00:00.000Z',
      },
    ],
    standingDmByAgent: {},
  });
  listThreads.mockResolvedValue({
    success: true,
    threads: [
      {
        id: 't-hermes',
        title: 'Plan the launch',
        source: 'boundary',
        agentSlug: 'assistant',
        kind: 'hermes', projectId: 'p1',
        updatedAt: new Date().toISOString(),
      },
      {
        id: 't-webui',
        title: 'Resume summary',
        source: 'webui',
        agentSlug: 'assistant',
        kind: 'hermes', projectId: 'p1',
        updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
    ],
  });
  listProjects.mockResolvedValue({
    success: true,
    activeId: 'p1',
    projects: [
      {
        id: 'p1',
        name: 'Job Search',
        hostPath: '/Users/ada/Documents/Job Search',
        containerPath: '/opt/projects/job-search',
        slug: 'job-search',
        kind: 'host-folder',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
  });
  inspectSources.mockResolvedValue({
    success: true,
    inspect: {
      projectId: 'p1',
      registryExists: false,
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
      ],
      index: [],
    },
  });
  addSourceFolder.mockResolvedValue({ success: false, canceled: true });
  pickCodingFolder.mockResolvedValue({
    success: true,
    hostPath: '/Users/ada/Notes/this-project',
    name: 'this-project',
    isGit: false,
    refuseMessage: null,
    managed: true,
  });
  selectProject.mockResolvedValue({ success: true });
  listChannels.mockResolvedValue({
    success: true,
    channels: [],
    lastOpened: null,
  });
  setLastOpened.mockResolvedValue({ success: true });
  listMentions.mockResolvedValue({ success: true, mentions: [] });
  markMentionsSeen.mockResolvedValue({ success: true });
  listProjectMarks.mockResolvedValue([]);
  countProjectSources.mockResolvedValue(0);
  createHermesChat.mockResolvedValue({
    success: true,
    thread: {
      id: 't-new',
      title: 'New chat',
      agentSlug: 'assistant',
      kind: 'hermes', projectId: 'p1',
    },
  });
}

export async function tearDownScreen() {
  // Let calls still in flight answer before the next test's mocks are set up.
  await ipcCalls.settle();
  cleanup();
  // Resetting drops answers a test gave its own mocks; setUpScreen puts the defaults back.
  for (const mock of screenMocks) mock.mockReset();
  // The coding-folders store is module state; a fresh screen starts from nothing loaded.
  resetCodingFoldersStoreForTests();
  resetKeptWritableForTests();
  window.localStorage.removeItem(INSPECTOR_OPEN_STORAGE_KEY);
}

const realMatchMedia = window.matchMedia;

/**
 * Whether the window counts as 1280px or wider, where the inspector sits beside the center pane
 * (ADR 0069 §5). happy-dom's window is 1024px, so the harness says so for every query it answers.
 */
export function setInspectorBeside(beside: boolean) {
  window.matchMedia = ((query: string) =>
    query === INSPECTOR_SIDE_QUERY
      ? ({
          matches: beside,
          media: query,
          onchange: null,
          addEventListener: (): void => undefined,
          removeEventListener: (): void => undefined,
          addListener: (): void => undefined,
          removeListener: (): void => undefined,
          dispatchEvent: (): boolean => false,
        } as MediaQueryList)
      : realMatchMedia.call(window, query)) as typeof window.matchMedia;
}

/** A fresh install: nothing stored, so the inspector starts closed. */
export function startInspectorClosed() {
  window.localStorage.removeItem(INSPECTOR_OPEN_STORAGE_KEY);
}
