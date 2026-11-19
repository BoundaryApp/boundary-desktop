import React, { useEffect, useState } from 'react';
import { SOVEREIGN_AGENT_STACK_VERSION } from '../../shared/assistantStackConstants';
import type { UpdateChannel, UpdateSnapshot } from '../../shared/types/updates';
import { Segmented } from '../components/ui/segmented';
import { SettingsRow, SettingsSection } from '../components/settings/SettingsSection';
import {
  UpdateTasks,
  downloadDetail,
  downloadTitle,
  formatSize,
  RestartActions,
  useRestartToInstall,
  useUpdates,
  waitingTitle,
} from './updates';
import { APP_NAME } from '../../shared/buildIdentity';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';

type HeroTone = 'ok' | 'brand' | 'warn';

const HERO_ICON: Record<HeroTone, React.ReactNode> = {
  ok: <path d="m4 10.5 4 4 8-9" />,
  brand: <path d="M10 3v9M6 8.5l4 4 4-4M4 16.5h12" />,
  warn: <path d="M10 4v7M10 14.5v.5" />,
};

function checkedAt(state: UpdateSnapshot): string {
  if (!state.lastCheckedAt) return `${APP_NAME} hasn’t checked yet.`;
  const checked = new Date(state.lastCheckedAt).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `Last checked ${checked}.`;
}

/** The personal key a gated feed needs. The field never shows the saved key. */
const FeedKeyRow: React.FC<{ onSave: (key: string) => void }> = ({ onSave }) => {
  const [key, setKey] = useState('');
  return (
    <SettingsRow
      label="Update key"
      hint="Your key is on the page you downloaded this app from."
      stacked
      onSubmit={(event) => {
        event.preventDefault();
        onSave(key);
        setKey('');
      }}
    >
      <input
        aria-label="Update key"
        className="mono"
        type="password"
        autoComplete="off"
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      <Button variant="secondary" block type="submit" disabled={!key.trim()}>
        Save key
      </Button>
    </SettingsRow>
  );
};

/** Settings → Updates (docs/updates-plan.md decision 11). The first card answers "am I up to date?". */
export const UpdatesPanel: React.FC = () => {
  const state = useUpdates();
  const { restart, sheet } = useRestartToInstall();
  const api = window.electronAPI?.updates;
  const showCard = state?.showCard ?? false;

  // The page says everything the card does, so opening it closes the card.
  useEffect(() => {
    if (showCard) void api?.closeCard();
  }, [api, showCard]);

  if (!state || !api) return null;

  const hero = (
    tone: HeroTone,
    title: string,
    body: string,
    actions: React.ReactNode = null,
    tasks = false
  ) => (
    <section
      className={`wb-settings-row wb-update-hero${tone === 'warn' ? ' is-warn' : ''}${tasks ? ' has-tasks' : ''}`}
      role="status"
    >
      <span className={`wb-update-tile${tone === 'brand' ? '' : ` is-${tone}`}`}>
        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {HERO_ICON[tone]}
        </svg>
      </span>
      <div className="wb-update-body">
        <h2>{title}</h2>
        <p className="wb-settings-hint">{body}</p>
      </div>
      {actions ? <div className="wb-update-row-actions">{actions}</div> : null}
      {tasks ? <UpdateTasks state={state} /> : null}
    </section>
  );

  const checkNow = (
    <Button variant="secondary" block type="button" disabled={state.checking} onClick={() => void api.check()}>
      Check now
    </Button>
  );
  const remaining = state.waiting.filter((item) => !item.finished).length;
  const news = state.version
    ? { version: state.version, summary: state.summary }
    : state.updated;

  const status = (): React.ReactNode => {
    if (state.blocked === 'not-in-applications') {
      return hero(
        'warn',
        `${APP_NAME} can’t update from this folder`,
        'Move it to Applications to get updates.',
        <Button variant="primary" block type="button" onClick={() => void api.moveToApplications()}>
          Move to Applications
        </Button>
      );
    }
    if (state.blocked === 'no-key') return hero('warn', 'Enter your update key', 'This build needs a personal key to get updates.');
    if (state.error === 'key') return hero('warn', 'Your update key wasn’t accepted', 'Check it against your download page, or ask for a new one.');
    if (state.blocked === 'no-feed') return hero('warn', 'This build doesn’t update itself', 'Update checks are off for this build.');
    if (state.restartIn !== null) {
      return hero(
        'brand',
        `Restarting in ${state.restartIn} seconds`,
        `Everything has finished. Restarting installs ${APP_NAME} ${state.version}.`,
        <RestartActions counting={true} />
      );
    }
    if (state.waiting.length > 0) {
      return hero(
        'brand',
        waitingTitle(remaining),
        'You get 30 seconds to stop it after the last one.',
        <RestartActions counting={false} />,
        true
      );
    }
    if (state.phase === 'ready') {
      const body = 'It installs when you quit. Restart now to get it sooner.';
      return hero(
        'brand',
        `${APP_NAME} ${state.version} is ready`,
        state.stackChanges ? `${body} The next start takes a few minutes while your tools update.` : body,
        <Button variant="primary" block type="button" onClick={restart}>
          Restart to update
        </Button>
      );
    }
    if (state.phase === 'downloading') {
      const detail = downloadDetail(state);
      return hero('brand', downloadTitle(state), detail ? `${detail}. Keep working.` : 'Keep working.');
    }
    if (state.phase === 'available') {
      const failed = state.error === 'download';
      return hero(
        failed ? 'warn' : 'brand',
        failed ? `${APP_NAME} ${state.version} didn’t download` : `${APP_NAME} ${state.version} is available`,
        failed
          ? `Nothing changed. You’re still on ${state.currentVersion}.`
          : state.size
            ? `${formatSize(state.size)} download.`
            : checkedAt(state),
        <>
          <Button variant="secondary" block type="button" onClick={() => void api.skipVersion()}>
            Skip this version
          </Button>
          <Button variant="primary" block type="button" onClick={() => void api.download()}>
            {failed ? 'Try again' : 'Download'}
          </Button>
        </>
      );
    }
    if (state.error === 'check') {
      return hero('warn', 'Couldn’t check for updates', `${APP_NAME} couldn’t reach the update server. Check your connection, then try again.`, checkNow);
    }
    return hero('ok', state.checking ? 'Checking…' : `${APP_NAME} is up to date`, checkedAt(state), checkNow);
  };

  return (
    <>
      {status()}

      {news && news.summary.length > 0 ? (
        <SettingsSection id="settings-updates-new" title={`What’s new in ${news.version}`}>
          <div className="wb-settings-row">
            <ul className="wb-update-lines">
              {news.summary.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection id="settings-updates-versions" title="Versions">
        <SettingsRow label={APP_NAME}>
          <span className="wb-update-version">{state.currentVersion}</span>
        </SettingsRow>
        <SettingsRow label="Your tools" hint={`Update with ${APP_NAME}`}>
          <span className="wb-update-version">{SOVEREIGN_AGENT_STACK_VERSION.replace(/^v/, '')}</span>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="settings-updates-preferences" title="Preferences">
        {state.keyRequired ? <FeedKeyRow onSave={(key) => void api.setFeedKey(key)} /> : null}
        <SettingsRow
          label="Release channel"
          hint="Beta gets new versions first. They pass the same tests, but fewer people have used them."
        >
          <Segmented<UpdateChannel>
            aria-label="Release channel"
            value={state.channel}
            onChange={(channel) => void api.setChannel(channel)}
            options={[
              { value: 'stable', label: 'Stable' },
              { value: 'beta', label: 'Beta' },
            ]}
          />
        </SettingsRow>
        <SettingsRow
          label="Check for updates"
          hint={
            state.checksEnabled
              ? state.keyRequired
                ? `${APP_NAME} downloads one small file once a day. Your update key identifies you when it does.`
                : `${APP_NAME} downloads one small file from GitHub once a day. It sends no ID and nothing about how you use it.`
              : `${APP_NAME} doesn’t check for updates, so it can’t tell you about security fixes. Check now still checks once.`
          }
        >
          <Switch
            checked={state.checksEnabled}
            label="Check for updates"
            onChange={(next) => void api.setChecksEnabled(next)}
          />
        </SettingsRow>
      </SettingsSection>
      {sheet}
    </>
  );
};
