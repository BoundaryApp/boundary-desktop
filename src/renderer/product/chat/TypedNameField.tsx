import React from 'react';
import { Input } from '../../components/ui/input';

/** The "Type <name> to confirm" field a delete or removal review asks for when work could be lost. */
export const TypedNameField: React.FC<{
  name: string;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  disabled?: boolean;
}> = ({ name, value, onChange, onEnter, disabled = false }) => (
  <label className="wb-field">
    <span>
      Type <span className="mono">{name}</span> to confirm
    </span>
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEnter();
      }}
      disabled={disabled}
      autoComplete="off"
      spellCheck={false}
      aria-label={`Type ${name} to confirm`}
    />
  </label>
);
