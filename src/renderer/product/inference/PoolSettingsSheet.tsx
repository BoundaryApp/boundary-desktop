import React from 'react';
import type { Precision, PoolSettings, TrustLevel } from '../../../shared/types/confidential';
import { Button } from '../../components/ui/button';
import { NativeSelect } from '../../components/ui/native-select';
import { Field } from '../../components/ui/field';
import { Sheet } from '../../components/ui/sheet';
import { CONFIDENTIAL_COPY } from './confidentialCopy';
import { LevelBadge } from './LevelBadge';
import { useConfidentialState } from './useConfidentialState';
import { Switch } from '../../components/ui/switch';
import { ChoiceGroup } from '../../components/ui/choice-group';
import { ChoiceRow } from '../../components/ui/choice-row';
import { Radio } from '../../components/ui/radio';

const LEVEL_TITLES: Record<TrustLevel, string> = { A: 'Level A only', B: 'Level B or better', C: 'Any level' };
const LEVELS: TrustLevel[] = ['A', 'B', 'C'];

const PRECISIONS: { value: Precision; label: string }[] = [
  { value: 'bf16', label: 'bf16, full precision' },
  { value: 'fp8', label: 'fp8, near full quality' },
  { value: 'fp4', label: 'fp4, cheapest, lower quality' },
];

const THRESHOLDS: PoolSettings['preferThresholdPercent'][] = [10, 20, 50];

const LevelChoice: React.FC<{
  name: string;
  label: string;
  value: TrustLevel;
  onChange: (level: TrustLevel) => void;
}> = ({ name, label, value, onChange }) => (
  <ChoiceGroup label={label} kind="radio">
    {LEVELS.map((level) => (
      <ChoiceRow
        key={level}
        variant="card"
        control={<Radio name={name} checked={value === level} onChange={() => onChange(level)} />}
        title={
          <>
            <LevelBadge level={level} /> {LEVEL_TITLES[level]}
          </>
        }
        description={CONFIDENTIAL_COPY.levels[level].text}
      />
    ))}
  </ChoiceGroup>
);

const SwitchRow: React.FC<{
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  children: React.ReactNode;
}> = ({ label, on, onChange, children }) => (
  <ChoiceRow
    variant="card"
    controlAt="end"
    className="mb-2"
    control={<Switch checked={on} label={label} onChange={onChange} />}
    title={label}
    description={children}
  />
);

/**
 * The settings every confidential pool shares (confidential inference spec decision 4). Each
 * change saves at once; main sends the new state back, so there is no Save button.
 */
export const PoolSettingsSheet: React.FC<{ open: boolean; onClose: () => void; onOpenHelp: () => void }> = ({
  open,
  onClose,
  onOpenHelp,
}) => {
  const { state, setSettings } = useConfidentialState();
  if (!state || state.enabled === false) return null;
  const { settings } = state;
  const save = (patch: Partial<PoolSettings>): void => {
    setSettings({ ...settings, ...patch }).catch((): void => undefined);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      titleId="pool-settings-title"
      backdropClassName="wb-conf-backdrop"
      title="Pool settings"
      actions={
        <>
          <Button variant="link" onClick={onOpenHelp}>
            How pools work
          </Button>
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <p className="wb-sheet-lede">These apply to every confidential pool.</p>
      <LevelChoice
        name="pool-chat-floor"
        label="Lowest trust level for chats"
        value={settings.chatFloor}
        onChange={(chatFloor) => save({ chatFloor })}
      />
      <LevelChoice
        name="pool-private-floor"
        label="Lowest trust level for private projects"
        value={settings.privateFloor}
        onChange={(privateFloor) => save({ privateFloor })}
      />
      <p className="wb-conf-note">A project can allow a lower level in its own settings.</p>
      <Field
        label="Lowest precision"
        htmlFor="pool-lowest-precision"
        hint="Some providers run smaller copies of a model to cut cost. A pool only uses copies at this precision or higher."
      >
        <NativeSelect
          id="pool-lowest-precision"
          value={settings.lowestPrecision}
          onChange={(event) => save({ lowestPrecision: event.target.value as Precision })}
        >
          {PRECISIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <SwitchRow
        label="Use providers that don’t state their precision"
        on={settings.allowUnstatedPrecision}
        onChange={(allowUnstatedPrecision) => save({ allowUnstatedPrecision })}
      >
        <span>Prem doesn’t say, for example. Off means those providers are skipped.</span>
      </SwitchRow>
      <SwitchRow
        label="Prefer one provider"
        on={settings.preferOneProvider}
        onChange={(preferOneProvider) => save({ preferOneProvider })}
      >
        <span>
          Keeps your chats on one provider, so fewer companies see when and how much you send. It moves only if that
          provider fails, or another is cheaper by more than:
        </span>
        {settings.preferOneProvider ? (
          <NativeSelect
            aria-label="Move when another provider is cheaper by more than"
            className="mt-2 w-auto max-w-[160px]"
            value={settings.preferThresholdPercent}
            onChange={(event) =>
              save({ preferThresholdPercent: Number(event.target.value) as PoolSettings['preferThresholdPercent'] })
            }
          >
            {THRESHOLDS.map((percent) => (
              <option key={percent} value={percent}>
                {percent}%
              </option>
            ))}
          </NativeSelect>
        ) : null}
      </SwitchRow>
    </Sheet>
  );
};
