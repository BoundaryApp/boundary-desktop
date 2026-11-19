import React, { useEffect, useRef, useState } from 'react';
import type { CircleSnapshot } from '../../../../shared/types/circles';
import { CALL_CHECK_MODES, type CallCheckMode, type CallCheckResult } from '../../../../shared/callCheck';
import { Field } from '../../../components/ui/field';
import { Sheet } from '../../../components/ui/sheet';
import { LONG_MS, LOAD_STREAMS, type CallCheck } from '../../circles/callCheck';
import { CallStage } from '../../circles/calls/CallStage';
import { getCallService } from '../../circles/calls/callService';
import { useCircleCall } from '../../circles/calls/useCircleCall';
import { Button } from '../../../components/ui/button';
import './circleChat.css';

const MODE_LABEL: Record<CallCheckMode, string> = {
  host: 'Local addresses',
  stun: 'STUN server',
  swarm: 'Hyperswarm address',
  tunnel: 'Circles tunnel',
  'stun+tunnel': 'STUN, then tunnel',
};

function cell(value: number | undefined, unit = ''): string {
  return value === undefined ? '–' : `${Math.round(value)}${unit}`;
}

const KIND_LABEL: Record<CallCheckResult['kind'], string> = { connect: '', load: 'load', long: 'long' };

function outcome(result: CallCheckResult): string {
  if (!result.connected) return `Failed at ${result.failedAt ?? 'unknown'}`;
  const pair = `${result.localType ?? '?'} → ${result.remoteType ?? '?'}`;
  return result.path ? `${pair} (${result.path})` : pair;
}

/** The room every Mac running the check joins for a test call. */
const TEST_ROOM = 'check';

/**
 * A real call in one room, with the camera and microphone, between members who join it from the
 * check. It tries the call service before the call screens exist.
 */
function TestCall({ circle }: { circle: CircleSnapshot }) {
  const { call, join } = useCircleCall(circle.key);
  const [joining, setJoining] = useState(false);
  // The sheet holds the test call's only controls, so closing it leaves the call, or stops a
  // join still opening the camera and microphone.
  const current = useRef(call);
  current.current = call;
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      if (pending.current) getCallService().cancel();
      else if (current.current?.room === TEST_ROOM) current.current.leave();
    },
    []
  );
  const names = Object.fromEntries(circle.members.map((member) => [member.identity, member.name]));
  return (
    <div className="wb-circle-check">
      <p className="wb-sheet-help">
        Test call joins a call with everyone in this Circle who presses it, using your camera and microphone.
      </p>
      <div className="wb-circle-check-actions">
        {call ? (
          <>
            <Button variant="secondary" block type="button" onClick={() => call.mute(!call.muted)}>
              {call.muted ? 'Unmute' : 'Mute'}
            </Button>
            <Button variant="secondary" block type="button" onClick={() => void call.setCamera(!call.camera)}>
              {call.camera ? 'Camera off' : 'Camera on'}
            </Button>
            <Button variant="secondary" block type="button" onClick={() => call.leave()}>
              Leave
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            block
            type="button"
            disabled={joining}
            onClick={() => {
              setJoining(true);
              pending.current = true;
              void join(TEST_ROOM, { audio: true, video: true })
                .catch((): null => null)
                .finally(() => {
                  pending.current = false;
                  if (mounted.current) setJoining(false);
                });
            }}
          >
            {joining ? 'Joining…' : 'Join test call'}
          </Button>
        )}
      </div>
      {call ? <CallStage call={call} names={names} /> : null}
    </div>
  );
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
  const [label, setLabel] = useState('');
  const [exported, setExported] = useState<string | null>(null);
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
      className="wb-sheet-table"
      actions={
        <>
          <Button
            variant="secondary"
            block
            type="button"
            disabled={results.length === 0}
            onClick={() => {
              void navigator.clipboard.writeText(JSON.stringify(results, null, 2));
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : 'Copy results'}
          </Button>
          <Button
            variant="secondary"
            block
            type="button"
            disabled={running !== null}
            onClick={() =>
              void window.electronAPI.circles.callCheckExport({ label, results }).then((saved) => {
                const failed = saved as { success: boolean; canceled?: boolean; error?: string };
                if (failed.success) setExported('Saved');
                else setExported(failed.canceled ? null : `Not saved: ${failed.error ?? 'unknown error'}`);
              })
            }
          >
            {exported ?? 'Export report…'}
          </Button>
          <Button variant="secondary" block type="button" disabled={running !== null} onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <p className="wb-sheet-help">
        Makes test connections to another member, who also runs the check. The STUN server learns both Macs’
        addresses. Results hold numbers only and are written to the Circles diagnostics file. Export report saves
        them with this launch’s diagnostics and this Mac’s details, to send after a run.
      </p>
      <Field label="This Mac’s network" htmlFor="call-check-network">
        <input
          id="call-check-network"
          type="text"
          value={label}
          maxLength={60}
          placeholder="For example: home Wi-Fi, phone hotspot"
          onChange={(event) => {
            setLabel(event.target.value);
            setExported(null);
          }}
        />
      </Field>
      {others.length === 0 ? (
        <p className="wb-sheet-help">Nobody else in {circle.name} is online.</p>
      ) : (
        <div className="wb-circle-check">
          <div className="wb-fields-inline">
            <Field label="Member" htmlFor="call-check-member">
              <select
                id="call-check-member"
                value={to}
                disabled={running !== null}
                onChange={(event) => setTo(event.target.value)}
              >
                {others.map((member) => (
                  <option key={member.identity} value={member.identity}>
                    {member.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Mode for video runs" htmlFor="call-check-mode">
              <select
                id="call-check-mode"
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
            </Field>
          </div>
          <div className="wb-circle-check-actions">
            <Button
              variant="primary"
              block
              type="button"
              disabled={running !== null || !to}
              onClick={() => void go('connect', () => check.checkConnection(circle.key, to, CALL_CHECK_MODES))}
            >
              {running === 'connect' ? 'Checking…' : 'Check connection'}
            </Button>
            <Button
              variant="secondary"
              block
              type="button"
              disabled={running !== null || !to}
              onClick={() => void go('load', () => check.checkLoad(circle.key, to, loadMode))}
            >
              {running === 'load' ? 'Sending video…' : `Video load (${LOAD_STREAMS} streams)`}
            </Button>
            <Button
              variant="secondary"
              block
              type="button"
              disabled={running !== null || !to}
              onClick={() => void go('long', () => check.checkLong(circle.key, to, loadMode))}
            >
              {running === 'long' ? 'In a long call…' : `Long call (${LONG_MS / 60_000} min)`}
            </Button>
          </div>
        </div>
      )}
      <TestCall circle={circle} />
      {results.length > 0 ? (
        <div className="wb-scroll-x wb-circle-check-results">
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
                <th>ICE checks</th>
                <th>Loss</th>
                <th>Parts</th>
                <th>Video fps</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result, index) => (
                <tr key={`${result.run}-${result.role}-${index}`}>
                  <td>
                    {result.run} {KIND_LABEL[result.kind]}
                  </td>
                  <td>{MODE_LABEL[result.mode]}</td>
                  <td>{result.role}</td>
                  <td>{outcome(result)}</td>
                  <td>{cell(result.msToConnect, ' ms')}</td>
                  <td>{cell(result.rttMs, ' ms')}</td>
                  <td>{cell(result.audioDelayMs, ' ms')}</td>
                  <td>
                    {result.checksSent === undefined ? '–' : `${Math.round(result.checksAnswered ?? 0)} / ${Math.round(result.checksSent)}`}
                  </td>
                  <td>{result.lossInPct === undefined ? '–' : `${result.lossInPct.toFixed(1)}%`}</td>
                  <td>{result.descriptionParts ?? '–'}</td>
                  <td>
                    {result.kind !== 'connect'
                      ? `${cell(result.sentFps)} / ${cell(result.receivedFps)}${result.limitedBy && result.limitedBy !== 'none' ? ` (${result.limitedBy})` : ''}`
                      : '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Sheet>
  );
};
