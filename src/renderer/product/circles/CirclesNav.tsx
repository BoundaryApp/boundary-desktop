import React from 'react';
import { Plus } from 'lucide-react';
import type { CircleSnapshot, CirclesState } from '../../../shared/types/circles';
import { TextButton } from './CircleControls';
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
  const joining = circles.join || circles.finishingJoin;
  if (selection?.kind === 'joining' && joining) return selection;
  if (!list.length) return joining ? { kind: 'joining' } : null;
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
      className={`flex w-full items-center gap-2.5 rounded-md p-2 text-left${selected ? ' bg-brand-dim' : ' hover:bg-surface-hover'}`}
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
      <span aria-hidden className={`wb-circle-ring${online > 1 ? ' is-live' : ''}`}>
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

function SharingIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
      <path d="M6.5 1.5v2.5M9.5 1.5v2.5M6.5 12v2.5M9.5 12v2.5M1.5 6.5H4M1.5 9.5H4M12 6.5h2.5M12 9.5h2.5" />
    </svg>
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
    <nav aria-label="Circles" className="wb-circles-nav flex w-[256px] shrink-0 flex-col border-r border-line bg-surface-1">
      <div className="flex items-center justify-between px-2 pb-2.5">
        <span className="text-title font-medium text-fg">Circles</span>
        {named ? (
          <button
            type="button"
            aria-label="Add a Circle"
            onClick={onAdd}
            className="relative z-[2] flex size-7 cursor-pointer items-center justify-center rounded-sm border border-line text-fg-muted hover:bg-surface-hover"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {list.length > 0 ? (
          <>
            <NavRow selected={selected?.kind === 'sharing'} onClick={() => onSelect({ kind: 'sharing' })}>
              <span className="wb-circle-tile">
                <SharingIcon />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-ui text-fg">Sharing</span>
                <span className="flex items-center gap-1.5 text-xs text-fg-faint">
                  <span className={`size-[7px] shrink-0 rounded-full ${sharing.dot}`} aria-hidden />
                  {sharing.label}
                </span>
              </span>
            </NavRow>
            <div className="m-2 h-px shrink-0 bg-line" />
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
            <span aria-hidden className="wb-circle-ring">
              …
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-ui text-fg">Joining…</span>
              <span className="text-xs text-fg-faint">{circles.join.waiting ? 'Finishes when an admin is online' : 'Couldn’t join'}</span>
            </span>
          </NavRow>
        ) : null}
      </div>
      {named ? (
        <div className="flex items-center gap-2 border-t border-line px-2 pt-2.5 pb-1 text-xs text-fg-faint">
          <span className={`size-[7px] shrink-0 rounded-full ${circles.status === 'running' ? 'bg-ok' : 'bg-line'}`} aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {circles.displayName} · {CONNECTION[circles.status]}
          </span>
          <TextButton onClick={onProfile}>Profile</TextButton>
        </div>
      ) : null}
    </nav>
  );
}
