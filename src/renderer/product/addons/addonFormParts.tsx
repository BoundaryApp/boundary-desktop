import React from 'react';
import { cn } from '../../lib/utils';
import { Field } from '../../components/ui/field';
import type { TwentyAccess } from '../../../shared/types/addons';
import { ACCESS_LABEL, bytesGB } from './addonCopy';

// Form pieces the add-on sheets share.

/** The two-setting choice of what agents may do (spec decision 7), with a line of help for each. */
export const AccessRadios: React.FC<{
  name: string;
  value: TwentyAccess;
  help: Record<TwentyAccess, string>;
  disabled?: boolean;
  className?: string;
  onChange(value: TwentyAccess): void;
}> = ({ name, value, help, disabled, className, onChange }) => (
  <div role="radiogroup" aria-label="What agents may do" className={cn('flex flex-col gap-2', className)}>
    <span className="text-xs font-medium text-fg">What agents may do</span>
    {(['read', 'write'] as const).map((option) => (
      <label key={option} className="flex cursor-pointer items-start gap-2 text-xs">
        <input
          type="radio"
          name={name}
          className="mt-0.5"
          checked={value === option}
          disabled={disabled}
          onChange={() => onChange(option)}
        />
        <span className="flex flex-col gap-0.5">
          <b className="font-medium text-fg">{ACCESS_LABEL[option]}</b>
          <span className="text-fg-muted">{help[option]}</span>
        </span>
      </label>
    ))}
  </div>
);

/** The field a removal asks the person to type `delete` into. */
export const TypeDeleteField: React.FC<{ id: string; value: string; onChange(value: string): void }> = ({
  id,
  value,
  onChange,
}) => (
  <Field label={<>Type <b>delete</b> to confirm</>} htmlFor={id}>
    <input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete="off"
      spellCheck={false}
      aria-label="Type delete to confirm"
    />
  </Field>
);

/** Removal's choice to delete the downloaded images too. */
export const DeleteImagesOption: React.FC<{
  checked: boolean;
  downloadBytes: number;
  /** "Installing again", "Getting it again". */
  again: string;
  onChange(checked: boolean): void;
}> = ({ checked, downloadBytes, again, onChange }) => (
  <label className="mb-3.5 flex cursor-pointer items-start gap-2 text-xs">
    <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span className="flex flex-col gap-0.5">
      <b className="font-medium text-fg">Also delete the downloaded images</b>
      <span className="text-fg-muted">{`Frees about ${bytesGB(downloadBytes)} GB. ${again} downloads them again.`}</span>
    </span>
  </label>
);

/** A row of small figures under a way to set an add-on up. */
export const Facts: React.FC<{ items: string[] }> = ({ items }) => (
  <p className="flex flex-wrap gap-x-3 gap-y-1 text-2xs tabular-nums text-fg-faint">
    {items.map((item) => (
      <span key={item}>{item}</span>
    ))}
  </p>
);

/** One way to set an add-on up, as a card on its detail page. */
export const SetupPath: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface-1 p-4">
    <h2 className="font-medium text-fg">{title}</h2>
    {children}
  </section>
);

export type SetupWay = 'here' | 'connect';

export const SETUP_WAY_TITLE: Record<SetupWay, string> = {
  here: 'Run it on this Mac',
  connect: 'Connect one you already use',
};

/**
 * The first step of Get for an add-on that can run here or connect elsewhere (store decision 14):
 * two cards of equal weight, nothing picked, and a click on either is the choice.
 */
export const SetupChoice: React.FC<{
  ways: Record<SetupWay, { body: string; facts: string[] }>;
  onPick(way: SetupWay): void;
}> = ({ ways, onPick }) => (
  <div role="group" aria-label="How to use it" className="grid gap-2.5 sm:grid-cols-2">
    {(['here', 'connect'] as const).map((way) => {
      const { body, facts } = ways[way];
      return (
        <button
          key={way}
          type="button"
          onClick={() => onPick(way)}
          className="flex cursor-pointer flex-col gap-2 rounded-lg border border-line bg-surface-1 p-4 text-left outline-none control-transition hover:border-brand focus-visible:shadow-(--focus-ring)"
        >
          <span className="font-medium text-fg">{SETUP_WAY_TITLE[way]}</span>
          <span className="text-xs leading-relaxed text-fg-muted">{body}</span>
          <Facts items={facts} />
        </button>
      );
    })}
  </div>
);

/** The kicker on a later step of Get: back to the choice between running here and connecting. */
export const ChangeWayLink: React.FC<{ onClick(): void; disabled?: boolean }> = ({ onClick, disabled }) => (
  <button type="button" className="cursor-pointer text-brand hover:underline" disabled={disabled} onClick={onClick}>
    ← Change
  </button>
);

/** Sheet classes for a later step of Get, so it replaces the step before without animating in. */
export const STILL_SHEET = { className: 'wb-sheet-wide wb-sheet-still', backdropClassName: 'wb-sheet-still' } as const;
