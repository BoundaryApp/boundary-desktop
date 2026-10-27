import React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils';

interface ChoiceRowProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Pill or status shown beside the title. */
  badge?: React.ReactNode;
  /** Accent border for the recommended path (ADR 0019). */
  recommended?: boolean;
  /** Whole row is a button; renders a chevron. Omit when `action` is set. */
  onSelect?: () => void;
  /** Explicit control on the right (e.g. a Sign in button). */
  action?: React.ReactNode;
  /** Extra content under the description (pickers, errors). */
  children?: React.ReactNode;
}

/** One option in a setup choice list: title, one line of why, and one action. */
export const ChoiceRow: React.FC<ChoiceRowProps> = ({
  title,
  description,
  badge,
  recommended = false,
  onSelect,
  action,
  children,
}) => {
  const frame = cn(
    'w-full rounded-lg border bg-surface-1 px-4 py-3 text-left transition-colors duration-(--dur-fast)',
    recommended ? 'border-brand/55' : 'border-line'
  );
  const header = (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-fg">{title}</span>
          {badge}
        </div>
        {description && <p className="mt-0.5 text-xs text-fg-faint">{description}</p>}
      </div>
      {action}
      {!action && onSelect && (
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-faint" />
      )}
    </div>
  );

  if (onSelect && !action) {
    return (
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          frame,
          'cursor-pointer outline-none hover:bg-surface-hover focus-visible:shadow-(--focus-ring)'
        )}
      >
        {header}
      </button>
    );
  }

  return (
    <div className={frame}>
      {header}
      {children && <div className="mt-3 flex flex-col gap-3">{children}</div>}
    </div>
  );
};
