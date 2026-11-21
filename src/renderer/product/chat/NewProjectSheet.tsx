import React, { useEffect, useId, useState } from 'react';
import type { CodingAgentBusy, CodingFolderInspect } from '../../../shared/types/codingFolders';
import type { ProjectCreateStep, ProjectCreateWhenBusy } from '../../../shared/types/projectCreate';
import { Callout } from '../../components/ui/alert';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { StepListRow } from '../../components/ui/step-list';
import { displayHostPath } from './chatTelemetryFormat';
import { CodingBusyButtons, CodingBusyWarning } from './CodingBusyChoice';
import { stepDetail, stepLook, stepName, stepRight } from './useProjectCreateSteps';
import { APP_NAME } from '../../../shared/buildIdentity';
import { Button } from '../../components/ui/button';
import { ChoiceRow } from '../../components/ui/choice-row';
import { Switch } from '../../components/ui/switch';
import { Input } from '../../components/ui/input';

/**
 * Confirm a project made from a folder (0005), with the coding switch from ADR 0028 §12:
 * on for a git repo, off otherwise, and the consequence stated beside it. Once Create is
 * clicked the sheet shows the create's steps until the project opens.
 */

export interface NewProjectInput {
  name: string;
  coding: boolean;
  whenCodingBusy?: ProjectCreateWhenBusy;
}

interface NewProjectSheetProps {
  folder: CodingFolderInspect | null;
  managed: boolean;
  busy?: boolean;
  error?: string | null;
  /** The running or last create's steps; null shows the form. */
  steps?: ProjectCreateStep[] | null;
  /** A coding task is running: ask whether to wait for it or stop it. */
  codingBusy?: CodingAgentBusy | null;
  /** The project was made, but the coding agent can't open its folder. */
  codingError?: string | null;
  onCreate: (input: NewProjectInput) => void;
  onCancel: () => void;
}

export function defaultCodingOn(folder: CodingFolderInspect | null, managed: boolean): boolean {
  return Boolean(managed && folder?.isGit && !folder.refuseMessage);
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch((): void => undefined);
}

export const NewProjectSheet: React.FC<NewProjectSheetProps> = ({
  folder,
  managed,
  busy = false,
  error = null,
  steps = null,
  codingBusy = null,
  codingError = null,
  onCreate,
  onCancel,
}) => {
  const codingHelpId = useId();
  const open = Boolean(folder?.hostPath);
  const [name, setName] = useState('');
  const [coding, setCoding] = useState(false);
  // What the last Create sent, for Try again.
  const [sent, setSent] = useState<NewProjectInput | null>(null);

  useEffect(() => {
    if (!folder?.hostPath) return;
    setName(folder.name ?? '');
    setCoding(defaultCodingOn(folder, managed));
    setSent(null);
  }, [folder, managed]);

  if (!open || !folder?.hostPath) return null;
  const canCode = managed && !folder.refuseMessage;
  const create = (input: NewProjectInput) => {
    setSent(input);
    onCreate(input);
  };
  const submit = () => {
    if (name.trim()) create({ name: name.trim(), coding: canCode && coding });
  };

  if (steps) {
    const failed = !busy && Boolean(error);
    const title = codingError
      ? `${sent?.name ?? name} is ready`
      : failed
        ? `Couldn’t create ${sent?.name ?? name}`
        : `Creating ${sent?.name ?? name}`;
    const stepsCoding = sent?.coding ?? coding;
    return (
      <Sheet
        open={open}
        onClose={onCancel}
        busy={busy}
        titleId="wb-new-project-title"
        title={title}
        error={error}
        actions={
          codingError ? (
            <Button variant="primary" block type="button" onClick={onCancel}>
              Close
            </Button>
          ) : failed ? (
            <>
              <Button variant="secondary" block type="button" onClick={onCancel}>
                Cancel
              </Button>
              <Button variant="secondary" block type="button" onClick={() => copyText(error ?? '')}>
                Copy details
              </Button>
              <Button
                variant="primary"
                block
                type="button"
                onClick={() => (sent ? create(sent) : submit())}
              >
                Try again
              </Button>
            </>
          ) : (
            <Button variant="primary" block type="button" disabled>
              Creating…
            </Button>
          )
        }
      >
        <div className="wb-field">
          <span>Folder</span>
          <div className="wb-field-static mono">{displayHostPath(folder.hostPath)}</div>
        </div>
        <ol aria-label="Create steps" className="flex flex-col">
          {steps.map((step) => (
            <StepListRow
              key={step.id}
              look={stepLook(step.status)}
              name={stepName(step.id)}
              detail={stepDetail(step.id, stepsCoding)}
              right={stepRight(step)}
            />
          ))}
        </ol>
        {codingError ? (
          <Callout variant="warn" layout="stacked" size="sm" className="wb-sheet-banner" role="status">
            <p>{codingError}</p>
            <p>The project is open.</p>
          </Callout>
        ) : null}
        {failed ? (
          <p className="wb-sheet-help">The project wasn’t saved.</p>
        ) : null}
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onCancel}
      busy={busy}
      titleId="wb-new-project-title"
      title={`Start a project from ${folder.name}`}
      error={error}
      actions={
        codingBusy?.busy && canCode && coding ? (
          <>
            <Button variant="secondary" block type="button" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <CodingBusyButtons
              verb="allow"
              look="sheet"
              disabled={busy || !name.trim()}
              onChoose={(mode) =>
                create({
                  name: name.trim(),
                  coding: true,
                  whenCodingBusy: mode === 'stop' ? 'stop' : 'wait',
                })
              }
            />
          </>
        ) : (
          <SheetConfirmActions
            busy={busy}
            onCancel={onCancel}
            confirmLabel={busy ? 'Creating…' : 'Create project'}
            confirmDisabled={!name.trim()}
            onConfirm={submit}
          >
            {canCode && coding ? (
              <span className="wb-sheet-note">Restarts the coding agent</span>
            ) : null}
          </SheetConfirmActions>
        )
      }
    >
      <label className="wb-field">
        <span>Name</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          disabled={busy}
          autoFocus
        />
      </label>
      <div className="wb-field">
        <span>Folder</span>
        <div className="wb-field-static mono">{displayHostPath(folder.hostPath)}</div>
      </div>
      <ChoiceRow
        variant="card"
        controlAt="end"
        className="mb-3.5"
        control={
          <Switch
            label="Let the coding agent work here"
            describedBy={codingHelpId}
            checked={canCode && coding}
            disabled={busy || !canCode}
            onChange={setCoding}
          />
        }
        title="Let the coding agent work here"
        descriptionId={codingHelpId}
        description={
          !managed
            ? `This ${APP_NAME} uses your own stack checkout, which manages coding folders itself.`
            : folder.refuseMessage
              ? folder.refuseMessage
              : folder.isGit
                ? 'On because this is a git repo. It can edit files and run commands without asking. You can turn it off from the Project tab.'
                : 'Off because this isn’t a git repo, so changes couldn’t be rolled back. It can edit files and run commands without asking.'
        }
      />
      {codingBusy?.busy && canCode && coding ? (
        <CodingBusyWarning agent={codingBusy} verb="allow" look="sheet" />
      ) : null}
    </Sheet>
  );
};
