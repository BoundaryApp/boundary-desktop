import React, { useCallback, useEffect, useState } from 'react';
import type { HostBridgeGrant } from '../../shared/types/hostBridge';
import { InfoTip } from '../components/ui/info-tip';
import { errorText } from '../components/ui/use-sheet-action';
import { APP_NAME } from '../../shared/buildIdentity';

/**
 * Settings → Computer access: Stop agent, Rotate tokens (ADR 0027 §3), and the host-bridge
 * grants Hermes holds with revoking them (ADR 0027 §7).
 */

type AgentState = { stopped: boolean; error?: string; hermesError?: string };
type Rotation = { status: 'running' } | { status: 'done' } | { status: 'failed'; error: string };

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

export function describeGrant(grant: HostBridgeGrant): { label: string; detail: string | null } {
  switch (grant.capability) {
    case 'notify':
      return { label: 'Show desktop notifications', detail: null };
    case 'open_url':
      return { label: `Open ${grant.resource} pages in your browser`, detail: null };
    case 'clipboard_write':
      return { label: 'Replace your clipboard', detail: null };
    case 'read_file':
      return { label: `Read ${basename(grant.resource)}`, detail: grant.resource };
    default:
      return { label: grant.capability, detail: grant.resource === '*' ? null : grant.resource };
  }
}

function when(grant: HostBridgeGrant): string {
  const since = new Date(grant.createdAt).toLocaleString();
  if (!grant.expiresAt) return `Since ${since}`;
  return `Since ${since}, until ${new Date(grant.expiresAt).toLocaleString()}`;
}

export const ComputerAccessPanel: React.FC = () => {
  const [grants, setGrants] = useState<HostBridgeGrant[] | null>(null);
  const [agent, setAgent] = useState<AgentState | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotation, setRotation] = useState<Rotation | null>(null);
  // A Stop agent, Turn access back on or Revoke whose call failed in main.
  const [agentError, setAgentError] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.electronAPI.hostBridge.listGrants().then((next) => alive && setGrants(next));
    void window.electronAPI.hostBridge.agentStopped().then((next) => alive && setAgent(next));
    return () => {
      alive = false;
    };
  }, []);

  const setStopped = useCallback(async (stopped: boolean) => {
    setBusy(true);
    setRotation(null);
    setAgentError(null);
    try {
      setAgent(await window.electronAPI.hostBridge.agentStopped(stopped));
    } catch (err) {
      setAgentError(
        `${stopped ? 'Couldn’t stop the agent' : 'Couldn’t turn access back on'}: ${errorText(err)}`
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const rotate = useCallback(async () => {
    setBusy(true);
    setRotation({ status: 'running' });
    try {
      const result = await window.electronAPI.hostBridge.rotateTokens();
      setRotation(result.success ? { status: 'done' } : { status: 'failed', error: result.error ?? 'Unknown error.' });
    } finally {
      setBusy(false);
    }
  }, []);

  const run = useCallback(async (action: () => Promise<HostBridgeGrant[]>) => {
    setBusy(true);
    setGrantError(null);
    try {
      setGrants(await action());
    } catch (err) {
      setGrantError(`Couldn’t revoke: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  if (!grants || !agent) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="size-8 animate-spin rounded-full border-2 border-line border-t-brand" />
      </div>
    );
  }

  return (
    <section className="wb-settings-section wb-computer-access" aria-labelledby="settings-computer-access">
      <h2 id="settings-computer-access">
        Computer access
        <InfoTip label="computer access">
          <p>
            Hermes can ask {APP_NAME} to show notifications, open pages in your browser, use the clipboard,
            and read or save files you choose. Each one asks you first. Reading the clipboard and saving
            files always ask.
          </p>
          <p>
            Every request, allowed or not, is recorded in <span className="mono">host-bridge/audit.jsonl</span>{' '}
            in {APP_NAME}’s app data folder. The log keeps sizes and file paths, never clipboard text or file
            contents.
          </p>
        </InfoTip>
      </h2>
      {agent.stopped ? (
        <div className="wb-inference-banner is-warn" role="status">
          <p>
            Agent stopped. Hermes can’t show notifications, open links, use your files or clipboard, or
            drive {APP_NAME}’s browser. This stays off after you restart {APP_NAME}, until you turn access
            back on here.
          </p>
          <div className="wb-agent-browser-actions">
            <button
              type="button"
              className="wb-inference-btn is-solid"
              disabled={busy}
              onClick={() => void setStopped(false)}
            >
              Turn access back on
            </button>
          </div>
        </div>
      ) : (
        <div className="wb-settings-row">
          <div>
            <p className="wb-settings-label">Stop agent</p>
            <p className="wb-settings-hint">
              Cuts Hermes off from this computer and {APP_NAME}’s browser now, and keeps it off until you
              turn access back on. Its tokens are replaced, so Hermes restarts.
            </p>
          </div>
          <button type="button" className="wb-inference-btn" disabled={busy} onClick={() => void setStopped(true)}>
            Stop agent
          </button>
        </div>
      )}
      {agentError ? (
        <div className="wb-inference-banner is-bad" role="alert">
          <p>{agentError}</p>
        </div>
      ) : null}
      {agent.error ? (
        <div className="wb-inference-banner is-bad" role="alert">
          <p>Access is back on, but {APP_NAME}’s tools didn’t start: {agent.error}</p>
        </div>
      ) : null}
      {agent.hermesError ? (
        <div className="wb-inference-banner is-bad" role="alert">
          <p>Access is back on, but Hermes didn’t get the new tokens: {agent.hermesError}</p>
        </div>
      ) : null}
      {agent.stopped ? null : (
        <div className="wb-settings-row">
          <div>
            <p className="wb-settings-label">Replace tokens</p>
            <p className="wb-settings-hint">
              Replaces the tokens Hermes uses to reach this computer and {APP_NAME}’s browser. The old ones
              stop working at once. Hermes restarts to pick up the new ones, which ends replies in
              progress, and {APP_NAME}’s browser closes.
            </p>
          </div>
          <button type="button" className="wb-inference-btn" disabled={busy} onClick={() => void rotate()}>
            {rotation?.status === 'running' ? 'Replacing…' : 'Replace tokens'}
          </button>
        </div>
      )}
      {rotation?.status === 'done' ? (
        <div className="wb-inference-banner" role="status">
          <p>New tokens are in use. The old ones no longer work.</p>
        </div>
      ) : null}
      {rotation?.status === 'failed' ? (
        <div className="wb-inference-banner is-bad" role="alert">
          <p>{rotation.error}</p>
        </div>
      ) : null}

      <p className="wb-inference-lead">What you’ve said Hermes can always do on this computer.</p>

      {grants.length === 0 ? (
        <div className="wb-settings-row">
          <p className="wb-settings-hint">Nothing is always allowed. Hermes asks each time.</p>
        </div>
      ) : (
        <>
          <ul className="wb-computer-access-list">
            {grants.map((grant) => {
              const { label, detail } = describeGrant(grant);
              return (
                <li key={`${grant.capability}:${grant.resource}`} className="wb-settings-row">
                  <div>
                    <p className="wb-settings-label">{label}</p>
                    {detail ? <p className="wb-settings-hint mono">{detail}</p> : null}
                    <p className="wb-settings-hint">{when(grant)}</p>
                  </div>
                  <button
                    type="button"
                    className="wb-inference-btn"
                    disabled={busy}
                    aria-label={`Revoke: ${label}`}
                    onClick={() => void run(() => window.electronAPI.hostBridge.revokeGrant(grant))}
                  >
                    Revoke
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="wb-agent-browser-actions">
            <button
              type="button"
              className="wb-inference-btn"
              disabled={busy}
              onClick={() => void run(() => window.electronAPI.hostBridge.revokeAllGrants())}
            >
              Revoke all
            </button>
          </div>
        </>
      )}
      {grantError ? (
        <div className="wb-inference-banner is-bad" role="alert">
          <p>{grantError}</p>
        </div>
      ) : null}

    </section>
  );
};
