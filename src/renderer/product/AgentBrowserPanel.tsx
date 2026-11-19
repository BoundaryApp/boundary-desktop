import React, { useCallback, useEffect, useState } from 'react';
import type { BoundaryBrowserState, HostBridgeBrowserSettings } from '../../shared/types/hostBridge';
import { SettingsRow, SettingsSection } from '../components/settings/SettingsSection';
import { InfoTip } from '../components/ui/info-tip';
import { APP_NAME } from '../../shared/buildIdentity';
import { WebSearchModeSection } from './WebSearchModeSection';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';

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
    void window.electronAPI.hostBridge.getBrowserState().then((next) => alive && adopt(next, true));
    const timer = setInterval(() => {
      void window.electronAPI.hostBridge.getBrowserState().then((next) => alive && adopt(next, false));
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
        const result = await window.electronAPI.hostBridge.updateBrowserSettings(settings);
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
      const result = await window.electronAPI.hostBridge.openBrowser();
      if (!result.success) setNotice({ tone: 'warn', text: result.error ?? 'Couldn’t open the browser.' });
      adopt(await window.electronAPI.hostBridge.getBrowserState(), false);
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
    <SettingsSection
      id="settings-agent-browser"
      className="wb-agent-browser"
      title={
        <>
            {APP_NAME}’s browser
            <InfoTip label={`${APP_NAME}’s browser`}>
              <p>
                A Chrome window {APP_NAME} runs on this computer, with its own profile. Sign in there to the
                sites you want Hermes to use. Your own Chrome and its logins aren’t touched.
              </p>
              <p>
                Hermes can’t read this browser’s cookies or stored site data, or open files on your computer.
                It can see and act on any page it opens. Sites limit automated use, so ask Hermes to go at a
                human pace.
              </p>
            </InfoTip>
        </>
      }
    >
      <p className="wb-inference-lead">Hermes browses here, with the logins you add.</p>

      <SettingsRow
        label={
          <>
            Let Hermes use {APP_NAME}’s browser
            <InfoTip label="this setting">
              When off, Hermes browses in its own browser inside Docker, with no logins.
            </InfoTip>
          </>
        }
      >
        <Switch
          checked={settings.enabled}
          label={`Let Hermes use ${APP_NAME}’s browser`}
          disabled={busy || !state.chromeInstalled}
          onChange={(enabled) =>
            void save(
              { ...settings, enabled },
              enabled ? `Hermes now browses in ${APP_NAME}’s browser.` : 'Hermes is back on its own browser.'
            )
          }
        />
      </SettingsRow>

      <SettingsRow label="Sign in to sites" hint={statusText(state)}>
        <Button
          variant="secondary"
          type="button"
          disabled={busy || !state.chromeInstalled}
          onClick={() => void openBrowser()}
        >
          Open browser
        </Button>
      </SettingsRow>

      {notice ? (
        <p className={`wb-agent-browser-notice is-${notice.tone}`} role="status">
          {notice.text}
        </p>
      ) : null}

      <h3 className="wb-agent-browser-h3">
        Blocked sites
        <InfoTip label="blocked sites">
          Hermes can’t open these sites or their subdomains. {APP_NAME}’s default list covers email,
          password managers, payments and banks. Keep sensitive sites here: Hermes can act on any page it
          opens.
        </InfoTip>
      </h3>
      <textarea
        className="wb-agent-browser-sites mono"
        aria-label="Blocked sites"
        value={blockedText}
        onChange={(event) => setBlockedText(event.target.value)}
        rows={8}
        spellCheck={false}
        placeholder="One site per line"
      />
      <p className="wb-settings-hint">
        {usingDefaults ? `${APP_NAME}’s default list` : 'You’ve changed the default list'}
      </p>
      <div className="wb-agent-browser-actions">
        <Button
          variant="secondary"
          type="button"
          disabled={busy}
          onClick={() => void save({ ...settings, blocked: linesToSites(blockedText) }, 'Blocked sites saved.')}
        >
          Save blocked sites
        </Button>
        {!usingDefaults ? (
          <Button
            variant="secondary"
            type="button"
            disabled={busy}
            onClick={() => void save({ ...settings, blocked: null }, 'Back to the default blocked sites.')}
          >
            Restore defaults
          </Button>
        ) : null}
      </div>

      <h3 className="wb-agent-browser-h3">
        Allowed sites
        <InfoTip label="allowed sites">
          Leave empty to let Hermes open any site that isn’t blocked. If you list sites here, Hermes can
          open only those. One site per line.
        </InfoTip>
      </h3>
      <textarea
        className="wb-agent-browser-sites mono"
        aria-label="Allowed sites"
        value={allowedText}
        onChange={(event) => setAllowedText(event.target.value)}
        rows={4}
        spellCheck={false}
        placeholder="Any site that isn’t blocked"
      />
      <div className="wb-agent-browser-actions">
        <Button
          variant="secondary"
          type="button"
          disabled={busy}
          onClick={() => void save({ ...settings, allowed: linesToSites(allowedText) }, 'Allowed sites saved.')}
        >
          Save allowed sites
        </Button>
      </div>

      <WebSearchModeSection />
    </SettingsSection>
  );
};
