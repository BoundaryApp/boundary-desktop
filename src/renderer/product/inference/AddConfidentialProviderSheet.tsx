import React, { useId, useState } from 'react';
import { meetsLevel, type CanonicalModel, type PoolSettings } from '../../../shared/types/confidential';
import type {
  AddProviderCheck,
  AddProviderResult,
  ConfidentialProviderView,
} from '../../../shared/types/confidentialState';
import { Callout } from '../../components/ui/alert';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { ChoiceGroup } from '../../components/ui/choice-group';
import { ChoiceRow } from '../../components/ui/choice-row';
import { Radio } from '../../components/ui/radio';
import { Field } from '../../components/ui/field';
import { Sheet } from '../../components/ui/sheet';
import { StepListRow, type StepLook } from '../../components/ui/step-list';
import { Stepper } from '../../components/ui/stepper';
import { CONFIDENTIAL_COPY, formatTurnCost } from './confidentialCopy';
import { LevelBadge } from './LevelBadge';

type Step = 'pick' | 'agree' | 'key' | 'check';

const STEPS: { id: Step; label: string }[] = [
  { id: 'pick', label: 'Choose' },
  { id: 'agree', label: 'What it sees' },
  { id: 'key', label: 'Key' },
  { id: 'check', label: 'Check' },
];

const CHECK_ORDER: AddProviderCheck['step'][] = ['key', 'attestation', 'models', 'tools'];

const CHECK_TITLES: Record<AddProviderCheck['step'], { ok: string; failed: string }> = {
  key: { ok: 'Key accepted', failed: 'Key not stored' },
  attestation: { ok: 'Hardware checked', failed: 'Hardware check failed' },
  models: { ok: 'Models listed', failed: 'No models listed' },
  tools: { ok: 'Tools run', failed: 'Tools don’t run' },
};

/** One row per step: the last check for it, since a keychain failure follows the passed key check. */
function checkRows(checks: AddProviderCheck[]): AddProviderCheck[] {
  return CHECK_ORDER.flatMap((step) => {
    const last = checks.filter((check) => check.step === step).at(-1);
    return last ? [last] : [];
  });
}

function checkLook(check: AddProviderCheck): StepLook {
  if (check.ok) return 'done';
  // A failed tool call still adds the provider; pools skip it for chats with tools.
  return check.step === 'tools' ? 'wait' : 'fail';
}

/** A key refused before anything else ran goes back to the key step with its sentence. */
function refusedKey(result: AddProviderResult): string | null {
  const [only] = result.checks;
  return result.added === false && result.checks.length === 1 && only.step === 'key' && only.ok === false
    ? only.detail
    : null;
}

export interface AddConfidentialProviderSheetProps {
  providers: ConfidentialProviderView[];
  models: CanonicalModel[];
  settings: PoolSettings;
  addProvider: (id: string, apiKey: string) => Promise<AddProviderResult>;
  onClose: () => void;
}

/**
 * Adds a confidential provider in four steps: choose, what it sees, key and check (confidential
 * inference spec decision 3). Main runs the checks and stores the key; this sheet only shows them.
 */
export const AddConfidentialProviderSheet: React.FC<AddConfidentialProviderSheetProps> = ({
  providers,
  models,
  settings,
  addProvider,
  onClose,
}) => {
  const providerName = useId();
  const [step, setStep] = useState<Step>('pick');
  const [id, setId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [result, setResult] = useState<AddProviderResult | null>(null);
  const [busy, setBusy] = useState(false);
  const modelName = (modelId: string) => models.find((model) => model.id === modelId)?.name ?? modelId;
  const chosen = providers.find((provider) => provider.id === id) ?? null;

  const check = async (): Promise<void> => {
    if (!chosen) return;
    setBusy(true);
    setKeyError(null);
    try {
      const next = await addProvider(chosen.id, apiKey);
      const refused = refusedKey(next);
      if (refused) {
        setKeyError(refused);
        setStep('key');
      } else {
        setResult(next);
        setStep('check');
      }
    } catch {
      setKeyError(`Boundary couldn’t check ${chosen.name}. Try again.`);
      setStep('key');
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode = null;
  let actions: React.ReactNode = null;
  const cancel = (
    <Button variant="secondary" disabled={busy} onClick={onClose}>
      Cancel
    </Button>
  );

  if (step === 'pick' || !chosen) {
    body = (
      <>
        <ChoiceGroup kind="radio" aria-label="Provider">
          {providers.map((provider) => (
            <ChoiceRow
              key={provider.id}
              variant="card"
              control={
                <Radio
                  name={providerName}
                  checked={provider.id === id}
                  disabled={provider.added}
                  onChange={() => setId(provider.id)}
                />
              }
              title={
                <span className="inline-flex items-center gap-1.5">
                  <LevelBadge level={provider.level} />
                  {provider.name}
                  {provider.added ? ' · added' : ''}
                </span>
              }
              description={
                <>
                  {CONFIDENTIAL_COPY.levels[provider.level].short}. {provider.levelReason}
                  <span className="wb-conf-note">
                    {provider.offers
                      .map((offer) => `${modelName(offer.modelId)} ${offer.turnCost === null ? 'no price' : formatTurnCost(offer.turnCost)}`)
                      .join(' · ')}{' '}
                    a turn · {provider.billing}
                  </span>
                </>
              }
              aside={
                meetsLevel(provider.level, settings.chatFloor) ? null : (
                  <span className="wb-inference-pill is-warn">Below your minimum</span>
                )
              }
            />
          ))}
        </ChoiceGroup>
        <p className="wb-conf-note">
          Boundary’s provider list sets each level and says why. Adding a provider is the only way it joins your pools.
        </p>
      </>
    );
    actions = (
      <>
        {cancel}
        <Button disabled={!chosen} onClick={() => setStep('agree')}>
          Next
        </Button>
      </>
    );
  } else if (step === 'agree') {
    const level = CONFIDENTIAL_COPY.levels[chosen.level];
    body = (
      <>
        <p className="wb-conf-heading">
          <LevelBadge level={chosen.level} />
          <b>
            {chosen.name} · Level {chosen.level}, {level.name.toLowerCase()}
          </b>
        </p>
        <p className="wb-sheet-lede">
          {level.text} {chosen.levelReason}
        </p>
        <ol className="wb-conf-checks">
          {CONFIDENTIAL_COPY.sees(chosen.name, chosen.billing).map((line) => (
            <StepListRow key={line.title} look={line.look === 'ok' ? 'done' : 'wait'} name={line.title} detail={line.text} />
          ))}
        </ol>
      </>
    );
    actions = (
      <>
        <Button variant="secondary" onClick={() => setStep('pick')}>
          Back
        </Button>
        {cancel}
        <Button onClick={() => setStep('key')}>Add {chosen.name}</Button>
      </>
    );
  } else if (step === 'key') {
    body = (
      <>
        <p className="wb-sheet-lede">
          Create an account and an API key at{' '}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => void window.electronAPI.urls.openUrl(chosen.keyUrl).catch((): void => undefined)}
          >
            {chosen.keyUrl.replace(/^https?:\/\//, '')}
          </Button>
          , and add some balance there. Boundary stores the key on this Mac with your Mac’s keychain and never sends it
          anywhere but {chosen.name}.
        </p>
        <Field
          label="API key"
          htmlFor="confidential-api-key"
          hint={keyError ? <span className="text-danger">{keyError}</span> : undefined}
        >
          <Input
            id="confidential-api-key"
            type="password"
            className="font-mono"
            placeholder="Paste the key"
            value={apiKey}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>
        {chosen.note ? (
          <Callout variant="info" size="sm" role={undefined}>
            <p>{chosen.note}</p>
          </Callout>
        ) : null}
      </>
    );
    actions = (
      <>
        <Button variant="secondary" disabled={busy} onClick={() => setStep('agree')}>
          Back
        </Button>
        {cancel}
        <Button disabled={busy || !apiKey.trim()} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Check and add'}
        </Button>
      </>
    );
  } else if (result) {
    body = (
      <ol className="wb-conf-checks" aria-label="Checks">
        {checkRows(result.checks).map((row) => (
          <StepListRow
            key={row.step}
            look={checkLook(row)}
            name={CHECK_TITLES[row.step][row.ok ? 'ok' : 'failed']}
            detail={row.detail}
          />
        ))}
      </ol>
    );
    actions = result.added ? (
      <Button onClick={onClose}>Done</Button>
    ) : (
      <>
        <Button variant="secondary" disabled={busy} onClick={() => setStep('key')}>
          Back
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Close
        </Button>
        <Button disabled={busy} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Check again'}
        </Button>
      </>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      busy={busy}
      titleId="confidential-add-title"
      backdropClassName="wb-conf-backdrop"
      title="Add a confidential provider"
      actions={actions}
    >
      <Stepper steps={STEPS} currentId={step} label="Add a provider steps" className="wb-conf-stepper" />
      {body}
    </Sheet>
  );
};
