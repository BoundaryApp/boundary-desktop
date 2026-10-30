import React, { useEffect } from 'react';
import { SOVEREIGN_AGENT_STACK_VERSION } from '../../shared/assistantStackConstants';
import type { UpdateChannel, UpdateSnapshot } from '../../shared/types/updates';
import { Segmented } from '../components/ui/segmented';
import { useRestartToInstall, useUpdates } from './updates';

function boundaryStatus(state: UpdateSnapshot): string {
  if (state.blocked === 'not-in-applications') {
    return `${state.currentVersion} · Boundary is outside Applications, so it can’t update itself.`;
  }
  if (state.blocked === 'no-feed') return `${state.currentVersion} · This build doesn’t update itself.`;
  if (state.phase === 'available') return `${state.currentVersion} · ${state.version} is available`;
  if (state.phase === 'downloading') return `${state.currentVersion} · Downloading ${state.version}`;
  if (state.phase === 'ready') {
    return `${state.currentVersion} · ${state.version} is ready to install`;
  }
  return state.currentVersion;
}

function checkStatus(state: UpdateSnapshot): string {
  if (state.checking) return 'Checking…';
  if (state.error === 'check') return 'Boundary couldn’t reach GitHub. Check your connection, then try again.';
  if (state.error === 'download') return 'The download didn’t finish. Nothing changed.';
  if (!state.lastCheckedAt) return 'Boundary hasn’t checked yet.';
  const checked = new Date(state.lastCheckedAt).toLocaleString();
  return state.phase === 'idle'
    ? `Boundary is up to date. Last checked ${checked}.`
    : `Last checked ${checked}.`;
}

/** Settings → Updates (docs/updates-plan.md decision 11). */
export const UpdatesPanel: React.FC = () => {
  const state = useUpdates();
  const { restart, sheet } = useRestartToInstall();
  const api = window.electronAPI?.updates;
  const offered = state?.version ?? null;

  // Opening the tab clears the dot, whether or not the user installs anything.
  useEffect(() => {
    if (offered) void api?.pageSeen();
  }, [api, offered]);

  if (!state || !api) return null;
  const canCheck = state.blocked === 'none';

  return (
    <>
      <section className="wb-settings-section" aria-labelledby="settings-updates-versions">
        <h2 id="settings-updates-versions">Versions</h2>
        <div className="wb-settings-row">
          <div>
            <p className="wb-settings-label">Boundary</p>
            <p className="wb-settings-hint">{boundaryStatus(state)}</p>
          </div>
          <div className="wb-update-row-actions">
            {state.blocked === 'not-in-applications' ? (
              <button
                type="button"
                className="wb-btn-solid"
                onClick={() => void api.moveToApplications()}
              >
                Move to Applications
              </button>
            ) : null}
            {state.phase === 'available' ? (
              <>
                <button type="button" className="wb-btn-ghost" onClick={() => void api.skipVersion()}>
                  Skip this version
                </button>
                <button type="button" className="wb-btn-solid" onClick={() => void api.download()}>
                  {state.error === 'download' ? 'Try again' : 'Download'}
                </button>
              </>
            ) : null}
            {state.phase === 'ready' ? (
              <button type="button" className="wb-btn-solid" onClick={restart}>
                Restart to install
              </button>
            ) : null}
          </div>
        </div>
        <div className="wb-settings-row">
          <div>
            <p className="wb-settings-label">Your tools</p>
            <p className="wb-settings-hint">
              {SOVEREIGN_AGENT_STACK_VERSION.replace(/^v/, '')} · Updates come with Boundary.
            </p>
          </div>
        </div>
        {offered && state.summary ? (
          <p className="wb-settings-hint">
            What’s new in {offered}: {state.summary}
          </p>
        ) : null}
      </section>

      <section className="wb-settings-section" aria-labelledby="settings-updates-preferences">
        <h2 id="settings-updates-preferences">Preferences</h2>
        <div className="wb-settings-row">
          <div>
            <p className="wb-settings-label">Release channel</p>
            <p className="wb-settings-hint">
              Beta gets new versions first. They pass the same tests, but fewer people have used them.
            </p>
          </div>
          <Segmented<UpdateChannel>
            aria-label="Release channel"
            value={state.channel}
            onChange={(channel) => void api.setChannel(channel)}
            options={[
              { value: 'stable', label: 'Stable' },
              { value: 'beta', label: 'Beta' },
            ]}
          />
        </div>
        <div className="wb-settings-row">
          <div>
            <p className="wb-settings-label">Check for updates</p>
            <p className="wb-settings-hint">
              {state.checksEnabled
                ? 'Boundary downloads one small file from GitHub once a day. It sends no ID and nothing about how you use it.'
                : 'Boundary doesn’t check for updates, so it can’t tell you about security fixes. Check now still checks once.'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={state.checksEnabled}
            aria-label="Check for updates"
            onClick={() => void api.setChecksEnabled(!state.checksEnabled)}
            className={`wb-switch${state.checksEnabled ? ' is-on' : ''}`}
          >
            <i />
          </button>
        </div>
        <div className="wb-settings-row">
          <div>
            <p className="wb-settings-hint" role="status">
              {canCheck ? checkStatus(state) : 'Update checks are off for this build.'}
            </p>
          </div>
          <button
            type="button"
            className="wb-btn-ghost"
            disabled={!canCheck || state.checking}
            onClick={() => void api.check()}
          >
            Check now
          </button>
        </div>
      </section>
      {sheet}
    </>
  );
};
