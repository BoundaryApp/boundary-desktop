import React, { useEffect, useState } from 'react';
import type { CircleSnapshot } from '../../../../shared/types/circles';
import { CALL_CHECK_MODES, type CallCheckMode, type CallCheckResult } from '../../../../shared/callCheck';
import { Sheet } from '../../../components/ui/sheet';
import { LOAD_STREAMS, type CallCheck } from '../../circles/callCheck';
import './circleChat.css';

const MODE_LABEL: Record<CallCheckMode, string> = {
  host: 'Local addresses',
  stun: 'STUN server',
  swarm: 'Hyperswarm address',
};

function cell(value: number | undefined, unit = ''): string {
  return value === undefined ? '–' : `${Math.round(value)}${unit}`;
}

function outcome(result: CallCheckResult): string {
  if (!result.connected) return `Failed at ${result.failedAt ?? 'unknown'}`;
  return `${result.localType ?? '?'} → ${result.remoteType ?? '?'}`;
}

/**
 * The call transport check (Circle calls spec phase 1), shown only while the app runs with
 * `BOUNDARY_CALLS_CHECK=1`. Results hold numbers and fixed words only, so they're safe to share.
 */
export const CallCheckSheet: React.FC<{
  check: CallCheck;
  circle: CircleSnapshot;
  open: boolean;
  onClose: () => void;
}> = ({ check, circle, open, onClose }) => {
  const others = circle.members.filter((member) => !member.isMe && member.online);
  const [to, setTo] = useState(others[0]?.identity ?? '');
  const [loadMode, setLoadMode] = useState<CallCheckMode>('stun');
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<CallCheckResult[]>(() => [...check.results]);
  const [copied, setCopied] = useState(false);
  useEffect(() => check.onResult(() => setResults([...check.results])), [check]);
  useEffect(() => {
    if (!others.some((member) => member.identity === to)) setTo(others[0]?.identity ?? '');
  }, [others, to]);

  const go = async (label: string, task: () => Promise<void>) => {
    setRunning(label);
    try {
      await task();
    } finally {
      setRunning(null);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      busy={running !== null}
      titleId="circle-call-check"
      title="Call check"
      className="wb-sheet-wide"
      actions={
        <>
          <button
            type="button"
            className="wb-btn-ghost"
            disabled={results.length === 0}
            onClick={() => {
              void navigator.clipboard.writeText(JSON.stringify(results, null, 2));
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : 'Copy results'}
          </button>
          <button type="button" className="wb-btn-ghost" disabled={running !== null} onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p className="wb-sheet-help">
        Makes test connections to another member, who also runs the check. The STUN server learns both Macs’
        addresses. Results hold numbers only and are written to the Circles diagnostics file.
      </p>
      {others.length === 0 ? (
        <p className="wb-sheet-help">Nobody else in {circle.name} is online.</p>
      ) : (
        <div className="wb-circle-check">
          <div className="wb-circle-share-pick">
            <label>
              <span>Member</span>
              <select value={to} disabled={running !== null} onChange={(event) => setTo(event.target.value)}>
                {others.map((member) => (
                  <option key={member.identity} value={member.identity}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Video load mode</span>
              <select
                value={loadMode}
                disabled={running !== null}
                onChange={(event) => setLoadMode(event.target.value as CallCheckMode)}
              >
                {CALL_CHECK_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {MODE_LABEL[mode]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="wb-circle-check-actions">
            <button
              type="button"
              className="wb-btn-solid"
              disabled={running !== null || !to}
              onClick={() => void go('connect', () => check.checkConnection(circle.key, to, CALL_CHECK_MODES))}
            >
              {running === 'connect' ? 'Checking…' : 'Check connection'}
            </button>
            <button
              type="button"
              className="wb-btn-ghost"
              disabled={running !== null || !to}
              onClick={() => void go('load', () => check.checkLoad(circle.key, to, loadMode))}
            >
              {running === 'load' ? 'Sending video…' : `Video load (${LOAD_STREAMS} streams)`}
            </button>
          </div>
        </div>
      )}
      {results.length > 0 ? (
        <table className="wb-circle-check-table" aria-label="Call check results">
          <thead>
            <tr>
              <th>Run</th>
              <th>Mode</th>
              <th>Role</th>
              <th>Result</th>
              <th>Connect</th>
              <th>Round trip</th>
              <th>Audio delay</th>
              <th>Parts</th>
              <th>Video fps</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result, index) => (
              <tr key={`${result.run}-${result.role}-${index}`}>
                <td>
                  {result.run} {result.kind === 'load' ? 'load' : ''}
                </td>
                <td>{MODE_LABEL[result.mode]}</td>
                <td>{result.role}</td>
                <td>{outcome(result)}</td>
                <td>{cell(result.msToConnect, ' ms')}</td>
                <td>{cell(result.rttMs, ' ms')}</td>
                <td>{cell(result.audioDelayMs, ' ms')}</td>
                <td>{result.descriptionParts ?? '–'}</td>
                <td>
                  {result.kind === 'load'
                    ? `${cell(result.sentFps)} / ${cell(result.receivedFps)}${result.limitedBy && result.limitedBy !== 'none' ? ` (${result.limitedBy})` : ''}`
                    : '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Sheet>
  );
};
