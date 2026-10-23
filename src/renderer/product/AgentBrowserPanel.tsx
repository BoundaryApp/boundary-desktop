import React, { useCallback, useEffect, useState } from 'react';
import type { BoundaryBrowserState, HostBridgeBrowserSettings } from '../../shared/types/hostBridge';
import { hostBridgeIPC } from '../services/hostBridgeIPCService';

/** Settings → Agent browser: Boundary's Chrome for Hermes (ADR 0027 §4, §6). */

const STATUS_POLL_MS = 5_000;

function linesToSites(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function statusText(state: BoundaryBrowserState): string {
  if (!state.chromeInstalled) return 'Needs Google Chrome, which isn’t installed.';
  if (!state.running) return 'Not open.';
  if (state.clients > 0) return 'Open. Hermes is using it now.';
  return 'Open.';
}

export const AgentBrowserPanel: React.FC = () => {
  const [state, setState] = useState<BoundaryBrowserState | null>(null);
  const [blockedText, setBlockedText] = useState('');
  const [allowedText, setAllowedText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  const adopt = useCallback((next: BoundaryBrowserState, resetText: boolean) => {
    setState(next);
    if (resetText) {
      setBlockedText(next.effectiveBlocked.join('\n'));
      setAllowedText(next.settings.allowed.join('\n'));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void hostBridgeIPC.getBrowserState().then((next) => alive && adopt(next, true));
    const timer = setInterval(() => {
      void hostBridgeIPC.getBrowserState().then((next) => alive && adopt(next, false));
    }, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [adopt]);

  const save = useCallback(
    async (settings: HostBridgeBrowserSettings, savedText: string) => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await hostBridgeIPC.updateBrowserSettings(settings);
        adopt(result.state, true);
        setNotice(
          result.hermesError
            ? { tone: 'warn', text: `Saved. Hermes will pick this up when it next starts (${result.hermesError}).` }
            : { tone: 'ok', text: savedText }
        );
      } catch (error) {
        setNotice({ tone: 'warn', text: error instanceof Error ? error.message : String(error) });
      } finally {
        setBusy(false);
      }
    },
    [adopt]
  );

  const openBrowser = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await hostBridgeIPC.openBrowser();
      if (!result.success) setNotice({ tone: 'warn', text: result.error ?? 'Couldn’t open the browser.' });
      adopt(await hostBridgeIPC.getBrowserState(), false);
    } finally {
      setBusy(false);
    }
  }, [adopt]);

  if (!state) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="size-8 animate-spin rounded-full border-2 border-line border-t-brand" />
      </div>
    );
  }

  const { settings } = state;
  const usingDefaults = settings.blocked === null;

  return (
    <section className="wb-settings-section wb-agent-browser" aria-labelledby="settings-agent-browser">
      <h2 id="settings-agent-browser">Boundary’s browser</h2>
      <p className="wb-inference-lead">
        Hermes can browse in a Chrome window Boundary runs on this computer, with its own profile. Sign in
        there to the sites you want Hermes to use. Your own Chrome and its logins aren’t touched.
      </p>

      <div className="wb-settings-row">
        <div>
          <p className="wb-settings-label">Let Hermes use Boundary’s browser</p>
          <p className="wb-settings-hint">
            When off, Hermes browses in its own browser inside Docker, with no logins.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          aria-label="Let Hermes use Boundary’s browser"
          disabled={busy || !state.chromeInstalled}
          onClick={() =>
            void save(
              { ...settings, enabled: !settings.enabled },
              settings.enabled ? 'Hermes is back on its own browser.' : 'Hermes now browses in Boundary’s browser.'
            )
          }
          className={`wb-switch${settings.enabled ? ' is-on' : ''}`}
        >
          <i />
        </button>
      </div>

      <div className="wb-settings-row">
        <div>
          <p className="wb-settings-label">Sign in to sites</p>
          <p className="wb-settings-hint">{statusText(state)}</p>
        </div>
        <button
          type="button"
          className="wb-inference-btn"
          disabled={busy || !state.chromeInstalled}
          onClick={() => void openBrowser()}
        >
          Open browser
        </button>
      </div>

      {notice ? (
        <p className={`wb-agent-browser-notice is-${notice.tone}`} role="status">
          {notice.text}
        </p>
      ) : null}

      <h3 className="wb-agent-browser-h3">Blocked sites</h3>
      <p className="wb-settings-hint">
        Hermes can’t open these sites or their subdomains. {usingDefaults ? 'This is Boundary’s default list: email, password managers, payments and banks.' : 'You’ve changed the default list.'} One per line.
      </p>
      <textarea
        className="wb-agent-browser-sites mono"
        aria-label="Blocked sites"
        value={blockedText}
        onChange={(event) => setBlockedText(event.target.value)}
        rows={8}
        spellCheck={false}
      />
      <div className="wb-agent-browser-actions">
        <button
          type="button"
          className="wb-inference-btn"
          disabled={busy}
          onClick={() => void save({ ...settings, blocked: linesToSites(blockedText) }, 'Blocked sites saved.')}
        >
          Save blocked sites
        </button>
        {!usingDefaults ? (
          <button
            type="button"
            className="wb-inference-btn"
            disabled={busy}
            onClick={() => void save({ ...settings, blocked: null }, 'Back to the default blocked sites.')}
          >
            Restore defaults
          </button>
        ) : null}
      </div>

      <h3 className="wb-agent-browser-h3">Allowed sites</h3>
      <p className="wb-settings-hint">
        Leave empty to let Hermes open any site that isn’t blocked. If you list sites here, Hermes can only open
        those. One per line.
      </p>
      <textarea
        className="wb-agent-browser-sites mono"
        aria-label="Allowed sites"
        value={allowedText}
        onChange={(event) => setAllowedText(event.target.value)}
        rows={4}
        spellCheck={false}
        placeholder="linkedin.com"
      />
      <div className="wb-agent-browser-actions">
        <button
          type="button"
          className="wb-inference-btn"
          disabled={busy}
          onClick={() => void save({ ...settings, allowed: linesToSites(allowedText) }, 'Allowed sites saved.')}
        >
          Save allowed sites
        </button>
      </div>

      <p className="wb-settings-hint wb-agent-browser-foot">
        Hermes can’t read this browser’s cookies or stored site data, or open files on your computer. It can see
        and act on any page it opens, so keep sensitive sites blocked. Sites limit automated use; ask Hermes to
        go at a human pace.
      </p>
    </section>
  );
};
