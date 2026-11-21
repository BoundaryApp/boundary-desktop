import React, { useEffect, useMemo, useState } from 'react';
import {
  REPORT_TITLE_MAX,
  composeReportBody,
  draftTitle,
  fitReportLink,
  reportAsText,
  type ReportContext,
  type ReportLink,
} from '../../../shared/bugReport';
import { Callout } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Field } from '../../components/ui/field';
import { Sheet } from '../../components/ui/sheet';
import { Stepper } from '../../components/ui/stepper';
import { Switch } from '../../components/ui/switch';
import { useSheetAction } from '../../components/ui/use-sheet-action';
import { Textarea } from '../../components/ui/textarea';
import { Input } from '../../components/ui/input';
import { SettingsRow } from '../../components/settings/SettingsSection';
import './bugReport.css';

type Step = 'describe' | 'review' | 'handoff';

const STEPS = [
  { id: 'describe', label: 'Describe' },
  { id: 'review', label: 'Review' },
  { id: 'handoff', label: 'Submit on GitHub' },
];

const LINK_NOTE: Record<ReportLink['moved'], string> = {
  none: 'Fits in the link to GitHub.',
  errors: 'Too long for a link. Boundary copies the errors, and you paste them into the issue.',
  all: 'Too long for a link. Boundary copies the report, and you paste it into the issue.',
};

const api = () => window.electronAPI.bugReport;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Collects app details and recent errors once, when the sheet opens. */
function useReportContext(): { context: ReportContext | null; failed: boolean } {
  const [state, setState] = useState<{ context: ReportContext | null; failed: boolean }>({
    context: null,
    failed: false,
  });
  useEffect(() => {
    let live = true;
    api()
      .collect()
      .then((context) => live && setState({ context, failed: false }))
      .catch(() => live && setState({ context: null, failed: true }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/**
 * The report sheet (bug report spec, Phase 1): Describe, Review, then a hand-off to GitHub in
 * the browser. Boundary never sends the report itself and never says it was sent.
 */
export const BugReportSheet: React.FC<{
  /** The screen the user was on, e.g. "Chat". */
  screen: string;
  onClose: () => void;
}> = ({ screen, onClose }) => {
  const { context, failed } = useReportContext();
  const action = useSheetAction();
  const [step, setStep] = useState<Step>('describe');
  const [what, setWhat] = useState('');
  const [expected, setExpected] = useState('');
  const [includeApp, setIncludeApp] = useState(true);
  const [includeErrors, setIncludeErrors] = useState(true);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReportLink['moved']>('none');

  const link = useMemo(() => fitReportLink(title, body), [title, body]);
  const removed = includeErrors ? (context?.redactions ?? []) : [];

  // Escape closes this sheet first, even over a Settings sheet that also listens for it.
  const { busy } = action;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [busy, onClose]);

  const toReview = () => {
    setTitle(draftTitle(what));
    setBody(composeReportBody({ what, expected, screen, includeApp, includeErrors, context }));
    setCopied(false);
    setNotice(null);
    setStep('review');
  };

  const copy = async () => {
    await navigator.clipboard.writeText(reportAsText(title, body));
    setCopied(true);
    setNotice(null);
  };

  const save = () =>
    action.run(async () => {
      const result = await api().save({ title, body });
      if (!result.success) action.setError(result.error ?? 'Could not save the report.');
      else if (result.saved) setNotice('Saved.');
    });

  const openInGitHub = () =>
    action.run(async () => {
      if (link.clipboard) await navigator.clipboard.writeText(link.clipboard);
      const result = await window.electronAPI.urls.openUrl(link.url);
      if (!result.success) {
        action.setError(result.error ?? 'Could not open the browser.');
        return;
      }
      setOpened(link.moved);
      setCopied(false);
      setStep('handoff');
    });

  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setCopied(false);
    setNotice(null);
  };

  // Review and the hand-off both let the user keep a copy outside GitHub.
  const keepButtons = (
    <>
      <Button variant="secondary" block type="button" disabled={action.busy} onClick={() => void save()}>
        Save as file…
      </Button>
      <Button variant="secondary" block type="button" disabled={action.busy} onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy report'}
      </Button>
    </>
  );
  const noticeLine = notice ? <span className="wb-sheet-note" role="status">{notice}</span> : null;

  let content: React.ReactNode;
  let actions: React.ReactNode;
  if (step === 'describe') {
    const found = context ? ` · ${plural(context.errors.length, 'error')} found` : '';
    content = (
      <>
        <Field label="What went wrong?" htmlFor="report-what">
          <Textarea
            id="report-what"
            autoFocus
            rows={4}
            value={what}
            placeholder="Search finds nothing, even for words I can see."
            onChange={(event) => setWhat(event.target.value)}
          />
        </Field>
        <Field label="What did you expect?" htmlFor="report-expected">
          <Input
            id="report-expected"
            value={expected}
            placeholder="Search shows the matching conversations."
            onChange={(event) => setExpected(event.target.value)}
          />
        </Field>
        <p className="wb-field-label">Include in the report</p>
        <div className="wb-settings-rows">
          <SettingsRow label="App details" hint="Version, macOS version, chip, screen you were on">
            <Switch label="App details" checked={includeApp} onChange={setIncludeApp} />
          </SettingsRow>
          <SettingsRow
            label="Recent errors"
            hint={
              failed
                ? 'Boundary could not read its log. The report goes without them.'
                : `Last 10 minutes, private details removed${found}`
            }
          >
            <Switch label="Recent errors" checked={includeErrors} onChange={setIncludeErrors} />
          </SettingsRow>
        </div>
      </>
    );
    actions = (
      <>
        <Button variant="secondary" block type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" block type="button" disabled={!what.trim()} onClick={toReview}>
          Continue
        </Button>
      </>
    );
  } else if (step === 'review') {
    content = (
      <>
        <Field label="Title" htmlFor="report-title">
          <Input
            id="report-title"
            value={title}
            maxLength={REPORT_TITLE_MAX}
            onChange={(event) => edit(setTitle)(event.target.value)}
          />
        </Field>
        <Field label="Issue text" htmlFor="report-body" hint={LINK_NOTE[link.moved]}>
          <Textarea
            id="report-body"
            className="min-h-[240px] font-mono"
            rows={14}
            value={body}
            onChange={(event) => edit(setBody)(event.target.value)}
          />
        </Field>
        <div className="wb-report-callouts">
          {removed.length ? (
            <Callout layout="stacked" role={undefined}>
              <p>
                <b>Removed before you saw this: {plural(removed.length, 'private detail')}</b>
              </p>
              <Button variant="link" size="sm" aria-expanded={showRemoved} onClick={() => setShowRemoved((shown) => !shown)}>
                {showRemoved ? 'Hide' : 'Show what changed'}
              </Button>
              {showRemoved ? (
                <ul className="wb-report-removed mono">
                  {removed.map((item, index) => (
                    <li key={index}>
                      <s>{item.shown}</s> <b>[{item.kind}]</b>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Callout>
          ) : null}
          <Callout variant="warn" role={undefined}>
            GitHub issues are public. Anyone can read this, so check it for anything personal.
          </Callout>
        </div>
      </>
    );
    actions = (
      <>
        <Button variant="secondary" block type="button" className="is-start" disabled={action.busy} onClick={() => setStep('describe')}>
          Back
        </Button>
        {keepButtons}
        <Button
          variant="primary"
          block
          type="button"
          disabled={action.busy || !title.trim() || !body.trim()}
          onClick={() => void openInGitHub()}
        >
          Open in GitHub
        </Button>
        {noticeLine}
      </>
    );
  } else {
    const items: { head: string; text: string }[] = [
      {
        head: 'Check the issue in your browser',
        text: 'The title and text are filled in. If GitHub asks you to sign in, your draft comes back afterwards.',
      },
    ];
    if (opened !== 'none') {
      items.push({
        head: opened === 'errors' ? 'Paste the errors into the issue' : 'Paste the report into the issue',
        text: `${opened === 'errors' ? 'They' : 'It'} didn't fit in the link, so Boundary copied ${opened === 'errors' ? 'them' : 'it'}.`,
      });
    }
    items.push({
      head: 'Press Submit',
      text: "Boundary can't see GitHub from here, so it won't mark the report as sent.",
    });
    content = (
      <>
        <ol className="wb-report-steps">
          {items.map((item, index) => (
            <li key={item.head}>
              <i aria-hidden="true">{index + 1}</i>
              <div>
                <b>{item.head}</b>
                <span>{item.text}</span>
              </div>
            </li>
          ))}
        </ol>
        <p className="wb-sheet-help">
          No GitHub account? Copy the report or save it as a file, and send it to the team another way.
        </p>
      </>
    );
    actions = (
      <>
        <Button variant="secondary" block type="button" className="is-start" disabled={action.busy} onClick={() => void openInGitHub()}>
          Open again
        </Button>
        {keepButtons}
        <Button variant="primary" block type="button" onClick={onClose}>
          Done
        </Button>
        {noticeLine}
      </>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      busy={action.busy}
      titleId="report-sheet-title"
      title={step === 'handoff' ? 'Finish in your browser' : 'Report a bug'}
      className="wb-sheet-wide wb-report-sheet"
      error={action.error}
      actions={actions}
    >
      <Stepper steps={STEPS} currentId={step} label="Report progress" className="wb-report-stepper" />
      {content}
    </Sheet>
  );
};
