import React, { useState } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import type { TwentyWorkspace } from '../../../shared/types/addons';
import { Panel } from './AddonPanel';
import { memGB } from './addonCopy';
import { agentName, hideMoveSteps, openLocalTwenty } from './useTwenty';

const Step: React.FC<{
  n: number;
  done: boolean;
  title: string;
  children: React.ReactNode;
}> = ({ n, done, title, children }) => (
  <li data-done={done} className="grid grid-cols-[22px_1fr] items-start gap-2.5 border-t border-line py-2.5 first:border-t-0">
    <span
      aria-hidden
      className={cn(
        'mt-0.5 grid size-5 place-items-center rounded-full border text-2xs font-semibold',
        done ? 'border-ok bg-ok text-surface-1' : 'border-line text-fg-muted'
      )}
    >
      {done ? '✓' : n}
    </span>
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-ui font-medium text-fg">{title}</span>
      {children}
    </div>
  </li>
);

/**
 * Three steps for moving from this Mac's Twenty to a hosted one. Boundary moves no records;
 * the page opens both and turns the local one off when the user says the copy is done.
 */
export const TwentyMoveSteps: React.FC<{
  hosted: TwentyWorkspace;
  reserveMiB: number;
  onTurnOff(): void;
  onRemove(): void;
  canRemove: boolean;
}> = ({ hosted, reserveMiB, onTurnOff, onRemove, canRemove }) => {
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const name = agentName(hosted);
  const open = async (target: string) => {
    try {
      const result = await window.electronAPI.urls.openUrl(target);
      setNote(result.success ? null : (result.error ?? `Couldn’t open ${name}.`));
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Panel title={`Moving to ${name}?`} lead="Agents can use both workspaces while you move. Nothing here moves records for you.">
      <ol className="flex flex-col">
        <Step n={1} done title="Connect the hosted workspace">
          <span className="text-xs text-fg-muted">{`${hosted.url} is connected as ${name}.`}</span>
        </Step>
        <Step n={2} done={copied} title="Copy your records">
          <span className="text-xs text-fg-muted">
            Export each list from this Mac’s Twenty, then import it in the hosted one. Notes and attachments may need copying by hand.
          </span>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => void openLocalTwenty().then(setNote)}>
              Open this Mac’s Twenty
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => void open(hosted.workspaceUrl || hosted.url)}>
              {`Open ${name}`}
            </Button>
          </div>
          <label className="mt-1 flex items-center gap-2 text-xs text-fg">
            <input type="checkbox" checked={copied} onChange={(e) => setCopied(e.target.checked)} />
            I’ve copied what I need
          </label>
        </Step>
        <Step n={3} done={false} title="Turn off this Mac’s Twenty">
          <span className="text-xs text-fg-muted">
            {`Frees ${memGB(reserveMiB)} GB of memory. Its data stays, so you can turn it on again to check something.`}
          </span>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant={copied ? 'primary' : 'secondary'} onClick={onTurnOff}>
              Turn off this Mac’s Twenty
            </Button>
            <Button type="button" size="sm" variant="danger" disabled={!canRemove} onClick={onRemove}>
              Remove and delete its data
            </Button>
          </div>
        </Step>
      </ol>
      {note ? <p className="text-xs text-fg-muted">{note}</p> : null}
      <p className="text-xs text-fg-faint">
        <button type="button" className="cursor-pointer text-brand hover:underline" onClick={hideMoveSteps}>
          Keep both
        </button>
        {' hides these steps.'}
      </p>
    </Panel>
  );
};
