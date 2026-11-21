import React, { useEffect, useState } from 'react';
import type { RuntimeProvisionSnapshot } from '../../shared/types/capability';
import { APP_NAME } from '../../shared/buildIdentity';
import { StepListRow } from '../components/ui/step-list';
import { DebugLogCopy } from '../components/settings/DebugLogCopy';
import { formatElapsed } from '../product/chat/kanbanActivity';
import { SetupShell } from './SetupShell';
import {
  preparingDescription,
  preparingRowSlow,
  preparingRows,
  type PreparingRow,
} from './preparingSteps';

function rowRight(row: PreparingRow, now: number): string {
  if (row.look === 'done') return 'Done';
  if (row.look === 'run' && row.startedAt !== undefined) {
    return formatElapsed((now - row.startedAt) / 1000);
  }
  return '';
}

/**
 * Setup's first screen while the Machine check runs: the container runtime's stages as a step
 * list, the engine's latest status line, and time on the running step. Once a step runs long
 * it says so and offers the debug log under Troubleshooting.
 */
export const SetupPreparing: React.FC<{
  stage: RuntimeProvisionSnapshot;
  /** The engine's latest status line. */
  message: string | null;
  debugLogPath?: string | null;
}> = ({ stage, message, debugLogPath }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const rows = preparingRows(stage);
  const running = rows.find((row) => row.look === 'run');
  const slow = running ? preparingRowSlow(running, now) : false;
  // A line from an earlier stage would describe the wrong row.
  const status = message && stage.stage !== 'docker' ? message : `${running?.name ?? 'Getting ready'}…`;

  return (
    <SetupShell step={null} title={`Preparing ${APP_NAME}`} description={preparingDescription(stage)}>
      <div className="flex flex-col">
        <p className="mb-2 text-ui text-fg-muted" role="status" aria-live="polite">
          {status}
        </p>
        <ol aria-label="Preparing steps" className="flex flex-col">
          {rows.map((row) => (
            <StepListRow
              key={row.id}
              look={row.look}
              name={row.name}
              detail={row.detail}
              right={rowRight(row, now)}
            />
          ))}
        </ol>
        {slow && (
          <div className="mt-4 flex flex-col gap-2">
            <p className="text-xs text-fg-faint">Still going. This step can take a few minutes.</p>
            <DebugLogCopy path={debugLogPath} />
          </div>
        )}
      </div>
    </SetupShell>
  );
};
