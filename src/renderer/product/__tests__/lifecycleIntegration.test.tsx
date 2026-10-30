import React from 'react';
import os from 'node:os';
import path from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge, settle, withIdleMain, type FakeBridge } from '../../__tests__/fakeBridge';

/**
 * The app's screen gate as the user meets it: the real `ProductApp`, setup state and stack
 * lifecycle store in the renderer, fed by main's real lifecycle code in `AssistantStackService`
 * through a fake bridge (ADR 0031 §5). Main's own dependencies below the lifecycle (compose,
 * project files, the health check) are faked. Each bug found by hand in the app lifecycle adds
 * a case here.
 */

const holder = vi.hoisted(() => ({ bridge: null as FakeBridge | null }));
const current = () => {
  if (!holder.bridge) throw new Error('No fake bridge installed');
  return holder.bridge;
};

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => path.join(os.tmpdir(), 'boundary-lifecycle-vitest', name),
    getAppPath: () => path.join(os.tmpdir(), 'boundary-lifecycle-vitest', 'app'),
    isPackaged: false,
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      current().main.handle(channel, handler),
  },
  // One window, the renderer under test.
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => current().main.send(channel, payload),
        },
      },
    ],
  },
  Notification: class {
    static isSupported = () => false;
    show = () => undefined;
    on = () => undefined;
  },
}));

vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown>;
    constructor(options?: { defaults?: Record<string, unknown> }) {
      this.store = { ...(options?.defaults ?? {}) };
    }
    get = (key: string) => this.store[key];
    has = (key: string) => this.store[key] !== undefined;
    set = (key: string, value: unknown) => {
      this.store[key] = value;
    };
    delete = (key: string) => {
      delete this.store[key];
    };
  },
}));

vi.mock('../../../main/persistDebugLog', () => ({ persistDebugLog: () => undefined }));

vi.mock('../../../main/services/assistant/resolveAssistantRoot', () => ({
  tryResolveAssistantRoot: () => ({ root: '/tmp/boundary-project', error: undefined }),
  resolveAssistantRoot: () => '/tmp/boundary-project',
}));

// The first step of a Hermes settings write; the test decides when it ends.
const projectFiles = vi.hoisted(() => ({
  finish: null as null | ((error?: Error) => void),
}));
vi.mock('../../../main/services/assistant/applyLlmToProjectEnv', () => ({
  applyLlmConnectionToProjectFiles: () =>
    new Promise<void>((resolve, reject) => {
      projectFiles.finish = (error) => (error ? reject(error) : resolve());
    }),
  clearLlmKeysFromProjectEnv: async () => false,
}));

// The ready workbench is out of scope here; the gate in front of it is under test.
// The app as the public repository has it; each experiment tests what it adds beside its code.
vi.mock('../../experiments', () => ({ rendererExperiments: [] }));

vi.mock('../ProductReadyShell', () => ({
  ProductReadyShell: () => <main aria-label="Workbench">Workbench</main>,
}));

import { SetupProvider } from '../../setup/SetupContext';
import { ProductApp } from '../ProductApp';
import { createLifecycleSnapshot } from '../../../shared/assistantStackLifecycle';
import {
  __test,
  applyLlmConnectionToHermes,
  setAssistantStackLifecycleCallback,
  setAssistantStackReadyCallback,
} from '../../../main/services/assistant/AssistantStackService';
import { registerAssistantStackHandlers } from '../../../main/services/assistant/ipcHandlers';
import { markAssistantStackSetupComplete } from '../../../main/services/assistant/AssistantStackStore';

const connection = {
  endpointUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-test-not-a-key',
  modelId: 'example/model',
  slot: 'openrouter' as const,
};

let bridge: FakeBridge;

function installBridge() {
  bridge = createFakeBridge();
  holder.bridge = bridge;
  bridge.install(
    withIdleMain(bridge, {
      assistantStack: {
        getStatus: bridge.invoke('assistant-stack:get-status'),
        getLifecycle: bridge.invoke('assistant-stack:get-lifecycle'),
        onLifecycle: bridge.listen('assistant-stack:lifecycle'),
        onReady: bridge.listen('assistant-stack:ready'),
      },
      setup: {
        getProgress: async () => ({
          completedBeforeOptionalSteps: false,
          hadProjectsBeforeOptionalSteps: false,
          outcomes: { folders: 'skipped' },
          pendingFolders: [],
        }),
      },
      capability: {
        getStatus: async () => ({ acknowledged: true, lastAssessment: null }),
        onProgress: bridge.listen('capability:progress'),
      },
      onboarding: { onLocalLlmChanged: bridge.listen('local-llm:changed') },
    })
  );
  registerAssistantStackHandlers();
}

const workbench = () => screen.queryByRole('main', { name: 'Workbench' });
const startupScreen = () => screen.queryByRole('list', { name: 'Your tools' });

/** Launches the app on a stack that start-up has already brought to ready. */
async function launchReady() {
  render(
    <SetupProvider>
      <ProductApp />
    </SetupProvider>
  );
  await settle();
  expect(workbench()).toBeTruthy();
  expect(startupScreen()).toBeNull();
}

describe('app lifecycle against main’s lifecycle code', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The stack's health check answers.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    projectFiles.finish = null;
    markAssistantStackSetupComplete();
    __test.setLifecycleSnapshot(createLifecycleSnapshot('ready', { stage: 'ready' }));
    installBridge();
  });
  afterEach(async () => {
    projectFiles.finish?.();
    await settle();
    cleanup();
    setAssistantStackLifecycleCallback(null);
    setAssistantStackReadyCallback(null);
    __test.resetLifecycle();
    __test.resetReadyForTests();
    holder.bridge = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    expect(bridge.unfaked).toEqual([]);
  });

  // Found by hand: Stop agent and provider switches re-apply Hermes's settings in the
  // background, and the app went back to its start-up screen until the write ended.
  it('stays on the workbench while a background Hermes settings write runs and fails', async () => {
    await launchReady();

    let applied: Awaited<ReturnType<typeof applyLlmConnectionToHermes>> | null = null;
    await act(async () => {
      void applyLlmConnectionToHermes(connection).then((result) => {
        applied = result;
      });
    });
    await act(async () => vi.advanceTimersByTime(1000));
    expect(projectFiles.finish).not.toBeNull();
    expect(workbench()).toBeTruthy();
    expect(startupScreen()).toBeNull();

    await act(async () => projectFiles.finish?.(new Error('Compose timed out')));
    await settle();
    expect(applied).toMatchObject({ success: false, error: 'Compose timed out' });
    expect(workbench()).toBeTruthy();
    expect(startupScreen()).toBeNull();
  });
  // The case above passes only if this screen can be seen: start-up's own apply shows it.
  it('shows the start-up screen while start-up applies the settings, and its error after', async () => {
    await launchReady();

    await act(async () => {
      void applyLlmConnectionToHermes(connection, { showProgress: true });
    });
    expect(startupScreen()).toBeTruthy();
    expect(workbench()).toBeNull();

    await act(async () => projectFiles.finish?.(new Error('Compose timed out')));
    await settle();
    expect(startupScreen()).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Starting your tools took too long');
  });
});
