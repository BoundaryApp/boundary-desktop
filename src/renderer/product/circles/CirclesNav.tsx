import React from 'react';
import { Plus } from 'lucide-react';
import type { CircleSnapshot, CirclesState } from '../../../shared/types/circles';
import { Button } from '../../components/ui/button';
import { offeredModelCount } from './CircleOffers';
import { useSharingSummary } from './CircleSharingPanel';

/**
 * The list beside a Circle's page: Sharing, the user's Circles, and their name and connection.
 * The shell holds the selection, so it survives leaving the destination.
 */

/** `person` is the identity whose panel is open. */
export type CirclesSelection =
  | { kind: 'sharing'; person?: string }
  | { kind: 'joining' }
  | { kind: 'circle'; key: string; person?: string }
  | null;

/** What to show: the choice if it still exists, otherwise the first Circle. Null means no Circles. */
export function resolveSelection(selection: CirclesSelection, circles: CirclesState): CirclesSelection {
  const list = circles.snapshot.circles;
  if (selection?.kind === 'joining' && circles.join) return selection;
  if (!list.length) return circles.join ? { kind: 'joining' } : null;
  if (selection?.kind === 'sharing') return selection;
  if (selection?.kind === 'circle' && list.some((circle) => circle.key === selection.key)) return selection;
  return { kind: 'circle', key: list[0].key };
}

function NavRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md p-2 text-left hover:bg-surface-hover${selected ? ' bg-surface-hover' : ''}`}
    >
      {children}
    </button>
  );
}

function CircleRow({ circle, selected, onSelect }: { circle: CircleSnapshot; selected: boolean; onSelect: () => void }) {
  const online = circle.members.filter((member) => member.online).length;
  const name = circle.name || 'Joining…';
  return (
    <NavRow selected={selected} onClick={onSelect}>
      <span
        aria-hidden
        className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-xs text-fg-muted ${online > 1 ? 'border-ok' : 'border-line'}`}
      >
        {name[0].toUpperCase()}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-ui text-fg">{name}</span>
        <span className="text-xs text-fg-faint">
          {online} of {circle.members.length} online
        </span>
      </span>
    </NavRow>
  );
}

const CONNECTION: Record<CirclesState['status'], string> = {
  stopped: 'Not connected',
  starting: 'Connecting',
  running: 'Connected',
  failed: 'Not connected',
};

export function CirclesNav({
  circles,
  selected,
  onSelect,
  onAdd,
  onProfile,
}: {
  circles: CirclesState;
  /** Resolved with `resolveSelection`. */
  selected: CirclesSelection;
  onSelect: (selection: CirclesSelection) => void;
  onAdd: () => void;
  onProfile: () => void;
}) {
  const sharing = useSharingSummary(circles, offeredModelCount(circles));
  const list = circles.snapshot.circles;
  const named = Boolean(circles.displayName);
  return (
    <nav aria-label="Circles" className="flex w-[256px] shrink-0 flex-col border-r border-line bg-surface-1">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <span className="text-title font-medium text-fg">Circles</span>
        {named ? (
          <Button size="sm" variant="ghost" aria-label="Add a Circle" onClick={onAdd}>
            <Plus className="size-4" aria-hidden />
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {list.length > 0 ? (
          <>
            <NavRow selected={selected?.kind === 'sharing'} onClick={() => onSelect({ kind: 'sharing' })}>
              <span className="flex min-w-0 flex-col">
                <span className="text-ui text-fg">Sharing</span>
                <span className="flex items-center gap-1.5 text-xs text-fg-faint">
                  <span className={`size-2 shrink-0 rounded-full ${sharing.dot}`} aria-hidden />
                  {sharing.label}
                </span>
              </span>
            </NavRow>
            <div className="mx-2 my-1 h-px shrink-0 bg-line" />
          </>
        ) : null}
        {list.map((circle) => (
          <CircleRow
            key={circle.key}
            circle={circle}
            selected={selected?.kind === 'circle' && selected.key === circle.key}
            onSelect={() => onSelect({ kind: 'circle', key: circle.key })}
          />
        ))}
        {circles.join ? (
          <NavRow selected={selected?.kind === 'joining'} onClick={() => onSelect({ kind: 'joining' })}>
            <span className="flex min-w-0 flex-col">
              <span className="text-ui text-fg">Joining…</span>
              <span className="text-xs text-fg-faint">{circles.join.waiting ? 'Waiting for an admin' : 'Couldn’t join'}</span>
            </span>
          </NavRow>
        ) : null}
      </div>
      {named ? (
        <div className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-xs text-fg-faint">
          <span className={`size-2 shrink-0 rounded-full ${circles.status === 'running' ? 'bg-ok' : 'bg-line'}`} aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {circles.displayName} · {CONNECTION[circles.status]}
          </span>
          <Button size="sm" variant="ghost" onClick={onProfile}>
            Profile
          </Button>
        </div>
      ) : null}
    </nav>
  );
}
