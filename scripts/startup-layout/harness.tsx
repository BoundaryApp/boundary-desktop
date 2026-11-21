/**
 * The start-up screen of a launch after an upgrade, for check.mjs: What's new for the version
 * in ./notes fills the story slot. `?notes=0` leaves the notes seen, so the tool story shows
 * instead; `?theme=light` picks the light palette.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { seedServiceProgress } from '../../src/shared/assistantStackLifecycle';
import { StartupScreen } from '../../src/renderer/product/startup/StartupScreen';
import './harness.css';

const params = new URLSearchParams(window.location.search);
if (params.get('theme') === 'light') document.documentElement.dataset.theme = 'light';
document.documentElement.dataset.platform = 'darwin';

const snapshot = {
  currentVersion: '0.0.2',
  upgradedFrom: '0.0.1',
  firstInstall: false,
  seen: params.get('notes') === '0' ? ['0.0.2'] : [],
  popups: true,
};

/** Every on* subscription is a no-op, What's new answers with the snapshot, and every other call resolves to null. */
const namespace = (key: string | symbol): unknown =>
  new Proxy(
    {},
    {
      get: (_target, name) => {
        if (key === 'whatsNew' && name === 'getState') return () => Promise.resolve(snapshot);
        if (typeof name === 'string' && /^on[A-Z]/.test(name)) return (): (() => void) => () => undefined;
        return () => Promise.resolve(null);
      },
    }
  );
(window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({}, { get: (_t, key) => namespace(key) });

createRoot(document.getElementById('root') as HTMLElement).render(
  <StartupScreen
    variant="launch"
    stage="compose"
    services={seedServiceProgress('pending', 'Queued…', 0.05)}
  />
);
