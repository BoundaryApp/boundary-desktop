import React, { useCallback, useEffect, useState } from 'react';
import type { HostBridgeGrant } from '../../shared/types/hostBridge';
import { hostBridgeIPC } from '../services/hostBridgeIPCService';
import { InfoTip } from '../components/ui/info-tip';

/** Settings → Computer access: the host-bridge grants Hermes holds, and revoking them (ADR 0027 §7). */

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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void hostBridgeIPC.listGrants().then((next) => alive && setGrants(next));
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(async (action: () => Promise<HostBridgeGrant[]>) => {
    setBusy(true);
    try {
      setGrants(await action());
    } finally {
      setBusy(false);
    }
  }, []);

  if (!grants) {
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
            Hermes can ask Boundary to show notifications, open pages in your browser, use the clipboard,
            and read or save files you choose. Each one asks you first. Reading the clipboard and saving
            files always ask.
          </p>
          <p>
            Every request, allowed or not, is recorded in <span className="mono">host-bridge/audit.jsonl</span>{' '}
            in Boundary’s app data folder. The log keeps sizes and file paths, never clipboard text or file
            contents.
          </p>
        </InfoTip>
      </h2>
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
                    onClick={() => void run(() => hostBridgeIPC.revokeGrant(grant))}
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
              onClick={() => void run(() => hostBridgeIPC.revokeAllGrants())}
            >
              Revoke all
            </button>
          </div>
        </>
      )}

    </section>
  );
};
