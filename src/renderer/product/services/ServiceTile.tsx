import React, { Children, useId, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Menu, MenuContent, MenuItem, MenuNote, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import { cn } from '../../lib/utils';

export type TileTone = 'faint' | 'ok' | 'warn' | 'danger' | 'brand';

const TONES: Record<TileTone, string> = {
  faint: 'text-fg-faint',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  brand: 'text-brand',
};

export interface TileMenuItem {
  label: string;
  onSelect(): void;
}

/**
 * One app on the Services screen, drawn like a home-screen icon: the face, the name and a
 * status line. A click does the tile's main thing; right-click or the ⋯ button shows the
 * rest. `notes` are plain lines at the top of that menu (the Calendar's accounts).
 */
export const ServiceTile: React.FC<{
  name: string;
  face: React.ReactNode;
  status: { text: React.ReactNode; tone: TileTone };
  /** A sentence on what it is, shown on hover. */
  hint?: string;
  dim?: boolean;
  disabled?: boolean;
  onClick(): void;
  menu: TileMenuItem[];
  notes?: string[];
}> = ({ name, face, status, hint, dim, disabled, onClick, menu, notes = [] }) => {
  const [open, setOpen] = useState(false);
  const statusId = useId();
  const hasMenu = menu.length > 0 || notes.length > 0;
  return (
    <div className="group relative" data-tile={name}>
      <button
        type="button"
        aria-label={name}
        aria-describedby={statusId}
        title={hint}
        disabled={disabled}
        onClick={onClick}
        onContextMenu={(e) => {
          if (!hasMenu) return;
          e.preventDefault();
          setOpen(true);
        }}
        className={cn(
          'flex w-full cursor-pointer flex-col items-center gap-2.5 rounded-2xl px-2 pt-3.5 pb-3 text-center outline-none hover:bg-surface-hover focus-visible:shadow-(--focus-ring) disabled:cursor-default disabled:hover:bg-transparent',
          open && 'bg-surface-hover'
        )}
      >
        <span
          className={cn(
            'transition-transform duration-(--dur-fast) group-hover:-translate-y-0.5',
            (dim || disabled) && 'opacity-55'
          )}
        >
          {face}
        </span>
        <span className="w-full truncate text-ui font-medium text-fg">{name}</span>
        <span id={statusId} className={cn('-mt-1.5 inline-flex items-center gap-1.5 text-xs tabular-nums', TONES[status.tone])}>
          {status.text}
        </span>
      </button>
      {hasMenu ? (
        <Menu open={open} onOpenChange={setOpen}>
          <MenuTrigger>
            <Button
              type="button"
              variant="quiet"
              size="icon-sm"
              aria-label={`More for ${name}`}
              className={cn('absolute top-2 right-2 opacity-0 focus-visible:opacity-100 group-hover:opacity-100', open && 'opacity-100')}
            >
              <MoreHorizontal aria-hidden />
            </Button>
          </MenuTrigger>
          <MenuContent aria-label={name} side="bottom" align="end">
            {notes.map((line) => (
              <MenuNote key={line}>{line}</MenuNote>
            ))}
            {notes.length && menu.length ? <MenuSeparator /> : null}
            {menu.map((item) => (
              <MenuItem key={item.label} onSelect={item.onSelect}>
                {item.label}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      ) : null}
    </div>
  );
};

/** The grid every row of tiles sits in. */
export const TileGrid: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div role="list" aria-label={label} className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
    {Children.map(children, (child) => (child ? <div role="listitem">{child}</div> : null))}
  </div>
);
