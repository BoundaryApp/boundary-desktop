import React from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import './circles.css';

/**
 * Circles' own controls, at the study's sizes. The shared switch and pill are smaller and suit
 * dense settings rows, so changing them would change every other screen.
 */

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => [...word][0].toUpperCase()).join('');
}

/** `dot` is a background class for the corner status dot, and `label` says it to a screen reader. */
export function Avatar({ name, dot, label, large = false }: { name: string; dot?: string; label?: string; large?: boolean }) {
  return (
    <span className={`wb-circle-avatar${large ? ' is-large' : ''}`}>
      <span aria-hidden>{initials(name)}</span>
      {dot ? <i className={dot} role="img" aria-label={label} /> : null}
    </span>
  );
}

export function CircleSwitch({
  label,
  on,
  disabled,
  onToggle,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`wb-circle-switch${on ? ' is-on' : ''}`}
    >
      <i />
    </button>
  );
}

export type CirclePillTone = 'ok' | 'warn' | 'brand' | 'quiet' | 'tag';

export function CirclePill({ tone = 'quiet', children }: { tone?: CirclePillTone; children: React.ReactNode }) {
  return <span className={`wb-circle-pill${tone === 'quiet' ? '' : ` is-${tone}`}`}>{children}</span>;
}

// `text-ui` here would read as a colour to tailwind-merge and drop the variant's text colour.
const HEIGHTS = {
  page: 'h-[34px] rounded-md px-3.5 text-[length:var(--size-ui)]',
  panel: 'h-[30px] rounded-sm px-2.5 text-xs',
  row: 'h-7 rounded-sm px-2.5 text-[length:var(--size-ui)]',
};

/** `page` is a page's action, `panel` the side panel's, `row` one inside a banner or box. */
export function CircleButton({
  size = 'page',
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'size'> & { size?: keyof typeof HEIGHTS }) {
  return <Button {...props} size="default" className={cn(HEIGHTS[size], 'font-normal', props.variant === 'default' && 'font-medium', className)} />;
}

/** Text that acts as a button, such as **Profile** and **Manage**. */
export function TextButton({ className, ...props }: React.ComponentProps<'button'>) {
  return <button type="button" {...props} className={cn('cursor-pointer underline underline-offset-2 disabled:opacity-50', className)} />;
}
