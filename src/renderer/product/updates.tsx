import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RunningWorkItem, UpdateSnapshot } from '../../shared/types/updates';
import { Sheet } from '../components/ui/sheet';
import { WorkingDot } from './chat/WorkingDot';

const UPDATED_CARD_MS = 10_000;

let current: UpdateSnapshot | null = null;
const listeners = new Set<() => void>();
let stopListening: (() => void) | null = null;
/** The rail button opened the card by hand, whatever `showCard` says. */
let opened = false;

function emit(): void {
  listeners.forEach((listener) => listener());
}

function publish(next: UpdateSnapshot): void {
  current = next;
  emit();
}

function setOpened(next: boolean): void {
  opened = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const api = window.electronAPI?.updates;
  if (api && !stopListening) {
    stopListening = api.onState(publish);
    void api.getState().then(publish);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = null;
    }
  };
}

/** The update state from main, shared by the card, the rail and the Updates tab. */
export function useUpdates(): UpdateSnapshot | null {
  return useSyncExternalStore(subscribe, () => current);
}

function useCardOpened(): boolean {
  return useSyncExternalStore(subscribe, () => opened);
}

export function resetUpdatesForTests(): void {
  current = null;
  opened = false;
  stopListening = null;
  listeners.clear();
}

export function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

export function waitingTitle(remaining: number): string {
  return `Restarting when ${remaining === 1 ? '1 task finishes' : `${remaining} tasks finish`}`;
}

export const UpdateTasks: React.FC<{ state: UpdateSnapshot }> = ({ state }) => (
  <ul className="wb-update-tasks">
    {state.waiting.map((item) => (
      <li key={item.id} className={item.finished ? 'is-finished' : ''}>
        {item.finished ? (
          <svg width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="m1.5 5.5 2.5 2.5 4.5-6" />
          </svg>
        ) : (
          <WorkingDot label="Running" />
        )}
        <span>{item.title}</span>
      </li>
    ))}
  </ul>
);

function WorkIcon({ kind }: { kind: RunningWorkItem['kind'] }) {
  return (
    <span className="wb-update-work-icon">
      <svg
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {kind === 'chat' ? (
          <path d="M2.5 10.5v-7A1.5 1.5 0 0 1 4 2h6a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 10 9H6l-3.5 2.5z" />
        ) : kind === 'task' ? (
          <path d="M3 2.5v7M7 2.5v4M11 2.5v9" />
        ) : (
          <path d="M9.5 10.5 13 7 9.5 3.5M4.5 3.5 1 7l3.5 3.5" />
        )}
      </svg>
    </span>
  );
}

/** **Restart to update**: restarts at once unless work is running, then asks in a sheet. */
export function useRestartToInstall(): { restart: () => void; sheet: React.ReactNode } {
  const [running, setRunning] = useState<RunningWorkItem[] | null>(null);
  const api = window.electronAPI?.updates;

  const restart = useCallback(() => {
    void api?.restart({ force: false }).then((result) => {
      if (result.status === 'work-running') setRunning(result.items);
    });
  }, [api]);

  const sheet = running ? (
    <Sheet
      open
      onClose={() => setRunning(null)}
      titleId="wb-update-restart-title"
      kicker="Restart to update"
      title="Some work is still running"
      actions={
        <>
          <button type="button" className="wb-btn-ghost" onClick={() => setRunning(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="wb-btn-ghost"
            onClick={() => {
              setRunning(null);
              void api?.restart({ force: true });
            }}
          >
            Restart now
          </button>
          <button
            type="button"
            className="wb-btn-solid"
            onClick={() => {
              void api?.restartWhenFinished(running);
              setRunning(null);
            }}
          >
            Restart when finished
          </button>
        </>
      }
    >
      <p className="wb-sheet-lede">
        Restarting stops it where it is. Boundary can wait and restart when it finishes.
      </p>
      <ul className="wb-update-work">
        {running.map((item) => (
          <li key={item.id}>
            <WorkIcon kind={item.kind} />
            <div>
              <b>{item.title}</b>
              <small>{item.detail}</small>
            </div>
            <WorkingDot label="Running" />
          </li>
        ))}
      </ul>
      <p className="wb-sheet-note">
        Boundary can’t see whether an automation is running. A restart stops any that are.
      </p>
    </Sheet>
  ) : null;

  return { restart, sheet };
}

type RailStage = 'available' | 'failed' | 'downloading' | 'ready' | 'waiting';

function railStage(state: UpdateSnapshot): RailStage {
  if (state.restartIn !== null || state.waiting.length > 0) return 'waiting';
  if (state.phase === 'ready') return 'ready';
  if (state.phase === 'downloading') return 'downloading';
  return state.error === 'download' ? 'failed' : 'available';
}

function railLabel(state: UpdateSnapshot, stage: RailStage): string {
  switch (stage) {
    case 'waiting':
      return state.restartIn === null ? 'Restarting when work finishes' : 'Restarting soon';
    case 'ready':
      return `Boundary ${state.version} is ready`;
    case 'downloading':
      return `Downloading Boundary ${state.version}`;
    case 'failed':
      return `Boundary ${state.version} didn’t download`;
    case 'available':
      return `Boundary ${state.version} is available`;
  }
}

const DownloadGlyph = () => (
  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 2.5v7.5M4.8 6.8 8 10l3.2-3.2M3 13.2h10" />
  </svg>
);

const RING = 75.4;

/** Sits above Settings while an update is in play, and opens the card. */
export const UpdateRailButton: React.FC<{ className?: string }> = ({ className = '' }) => {
  const state = useUpdates();
  const cardOpened = useCardOpened();
  if (!state) return null;
  const stage = railStage(state);
  const remaining = state.waiting.filter((item) => !item.finished).length;
  const done = state.restartIn === null
    ? 1 - remaining / Math.max(1, state.waiting.length)
    : 1 - state.restartIn / 30;
  const label = railLabel(state, stage);
  const isOpen = cardOpened || state.showCard || state.showUpdated;
  return (
    <button
      type="button"
      data-update-button
      title={label}
      aria-label={label}
      aria-expanded={isOpen}
      onClick={() => {
        // Closing what opened by itself counts as closing it, so it doesn't reopen.
        const api = window.electronAPI?.updates;
        setOpened(!isOpen);
        if (state.showUpdated) void api?.closeUpdated();
        else if (state.showCard) void api?.closeCard();
      }}
      className={`wb-icon-btn wb-update-btn is-${stage} ${className}`}
    >
      {stage === 'ready' ? (
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13.2 8A5.2 5.2 0 1 1 11.6 4.3" />
          <path d="M13.2 2.4v3h-3" />
        </svg>
      ) : stage === 'waiting' ? (
        <>
          <svg className="wb-update-ring" viewBox="0 0 26 26" aria-hidden="true">
            <circle cx="13" cy="13" r="12" />
            <circle className="is-arc" cx="13" cy="13" r="12" strokeDasharray={RING} strokeDashoffset={RING * done} />
          </svg>
          <span className="wb-update-count">{state.restartIn ?? remaining}</span>
        </>
      ) : (
        <>
          {stage === 'downloading' ? (
            <svg className="wb-update-ring is-sweeping" viewBox="0 0 26 26" aria-hidden="true">
              <circle cx="13" cy="13" r="12" />
              <circle className="is-arc" cx="13" cy="13" r="12" strokeDasharray="20 56" />
            </svg>
          ) : null}
          <DownloadGlyph />
        </>
      )}
    </button>
  );
};

function Lines({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="wb-update-lines">
      {lines.slice(0, 3).map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/** The update card beside the rail button (ADR 0037). It never takes focus. */
export const UpdateCard: React.FC<{ onOpenUpdates: () => void }> = ({ onOpenUpdates }) => {
  const state = useUpdates();
  const cardOpened = useCardOpened();
  const { restart, sheet } = useRestartToInstall();
  const api = window.electronAPI?.updates;
  const ref = useRef<HTMLElement>(null);

  const updated = state?.showUpdated ? state.updated : null;
  const lastCall = state?.restartIn != null;
  const open = Boolean(state) && (lastCall || Boolean(updated) || cardOpened || Boolean(state?.showCard));

  const collapse = useCallback(() => {
    setOpened(false);
    if (current?.showUpdated) void api?.closeUpdated();
    else if (current?.showCard) void api?.closeCard();
  }, [api]);

  useEffect(() => api?.onRestartRequested(restart), [api, restart]);

  useEffect(() => {
    if (!updated) return;
    const timer = setTimeout(collapse, UPDATED_CARD_MS);
    return () => clearTimeout(timer);
  }, [updated, collapse]);

  // A click anywhere else is Later. The rail button stays, so nothing is lost.
  useEffect(() => {
    if (!open || lastCall) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (ref.current?.contains(target) || target.closest?.('[data-update-button]')) return;
      collapse();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, lastCall, collapse]);

  if (!state || !api) return null;

  const body = (): React.ReactNode => {
    if (state.restartIn !== null) {
      return (
        <>
          <h3>Restarting in {state.restartIn} seconds</h3>
          <p>Everything has finished. Restarting installs Boundary {state.version}.</p>
          <div className="wb-update-bar" aria-hidden="true">
            <i className="is-drain" style={{ width: `${(state.restartIn / 30) * 100}%` }} />
          </div>
          <div className="wb-update-actions">
            <button type="button" className="wb-btn-solid" onClick={() => void api.restart({ force: true })}>
              Restart now
            </button>
            <button type="button" className="wb-btn-ghost" onClick={() => void api.cancelWaiting()}>
              Not now
            </button>
          </div>
        </>
      );
    }
    if (state.waiting.length > 0) {
      return (
        <>
          <h3>{waitingTitle(state.waiting.filter((item) => !item.finished).length)}</h3>
          <UpdateTasks state={state} />
          <div className="wb-update-actions">
            <button type="button" className="wb-btn-ghost" onClick={() => void api.restart({ force: true })}>
              Restart now
            </button>
            <button type="button" className="wb-btn-ghost" onClick={() => void api.cancelWaiting()}>
              Cancel restart
            </button>
          </div>
        </>
      );
    }
    if (updated) {
      return (
        <>
          <h3>Boundary is now {updated.version}</h3>
          <Lines lines={updated.summary} />
          <div className="wb-update-actions">
            <button
              type="button"
              className="wb-btn-ghost"
              onClick={() => {
                collapse();
                onOpenUpdates();
              }}
            >
              See what changed
            </button>
            <button type="button" className="wb-update-link" onClick={collapse}>
              Close
            </button>
          </div>
        </>
      );
    }
    if (state.phase === 'ready') {
      return (
        <>
          <h3>Boundary {state.version} is ready</h3>
          <p>It installs when you quit. Restart now to get it sooner.</p>
          {state.stackChanges ? <p>The next start takes a few minutes while your tools update.</p> : null}
          <div className="wb-update-actions">
            <button type="button" className="wb-btn-solid" onClick={restart}>
              Restart to update
            </button>
            <button type="button" className="wb-btn-ghost" onClick={collapse}>
              Later
            </button>
          </div>
        </>
      );
    }
    const size = state.size ? <span className="wb-update-size">{formatSize(state.size)}</span> : null;
    if (state.phase === 'downloading') {
      return (
        <>
          <div className="wb-update-card-head">
            <h3>Downloading Boundary {state.version}</h3>
            {size}
          </div>
          <p>Keep working. Boundary tells you when it’s ready.</p>
          <div className="wb-update-bar" aria-hidden="true">
            <i />
          </div>
          <div className="wb-update-actions">
            <button type="button" className="wb-update-link" onClick={collapse}>
              Hide
            </button>
          </div>
        </>
      );
    }
    if (state.error === 'download') {
      return (
        <>
          <h3>Boundary {state.version} didn’t download</h3>
          <p>Nothing changed. You’re still on {state.currentVersion}.</p>
          <div className="wb-update-actions">
            <button type="button" className="wb-btn-solid" onClick={() => void api.download()}>
              Try again
            </button>
            <button type="button" className="wb-btn-ghost" onClick={collapse}>
              Later
            </button>
          </div>
        </>
      );
    }
    return (
      <>
        <div className="wb-update-card-head">
          <h3>Boundary {state.version} is available</h3>
          {size}
        </div>
        <Lines lines={state.summary} />
        <div className="wb-update-actions">
          <button type="button" className="wb-btn-solid" onClick={() => void api.download()}>
            Download
          </button>
          <button type="button" className="wb-btn-ghost" onClick={collapse}>
            Later
          </button>
          <button type="button" className="wb-update-link" onClick={() => void api.skipVersion()}>
            Skip this version
          </button>
        </div>
      </>
    );
  };

  return (
    <>
      {open && (state.version || updated) ? (
        <section
          ref={ref}
          className="wb-update-card"
          role="status"
          aria-label="Boundary update"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !lastCall) collapse();
          }}
        >
          {body()}
        </section>
      ) : null}
      {sheet}
    </>
  );
};
