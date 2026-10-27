import React, { useEffect, useMemo, useState } from 'react';
import type {
  HermesProjectRecord,
  SessionInferenceOverride,
} from '../../../shared/types/hermesChat';
import { useInferenceStatus } from '../../onboarding/inferenceStatus';
import { Sheet } from '../../components/ui/sheet';
import { displayHostPath } from './chatTelemetryFormat';
import { ProjectGlyph } from './ProjectGlyph';
import { effectiveInference, moveEffects, type MoveEffect } from './projectMove';

export interface MoveProjectTarget {
  /** Session ids to move (one from a chat, several from All chats). */
  sessionIds: string[];
  /** What the sheet calls them: a chat title in quotes, or "3 chats". */
  label: string;
  /** Their current project when they share one; undefined when they come from several. */
  fromProjectId: string | null | undefined;
  /** A DM changes the folder it works in rather than moving (ADR 0024 §7). */
  isDm?: boolean;
}

interface MoveProjectSheetProps {
  target: MoveProjectTarget | null;
  projects: HermesProjectRecord[];
  agentName: string;
  busy?: boolean;
  error?: string | null;
  onMove: (projectId: string | null) => void;
  onCancel: () => void;
}

function EffectIcon({ kind }: { kind: MoveEffect['kind'] }) {
  const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true };
  if (kind === 'folder' || kind === 'sources') {
    return (
      <svg {...common}>
        <path
          d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.5 1.6h4.7A1.5 1.5 0 0 1 14 6.1v5.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"
          stroke="currentColor"
          strokeWidth="1.4"
        />
      </svg>
    );
  }
  if (kind === 'history') {
    return (
      <svg {...common}>
        <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.8v2.6h2.6M8 5v3.2l2 1.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'cloud') {
    return (
      <svg {...common}>
        <path d="M4.5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.7 1 2.5 2.5 0 0 1-.4 5z" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/**
 * Move to project… (ADR 0024 §6): pick where the conversation lives, see what changes before
 * it happens. A DM uses the same sheet to change the folder its agent works in.
 */
export const MoveProjectSheet: React.FC<MoveProjectSheetProps> = ({
  target,
  projects,
  agentName,
  busy = false,
  error = null,
  onMove,
  onCancel,
}) => {
  const [dest, setDest] = useState<string | null>(null);
  const { status } = useInferenceStatus();
  const [override, setOverride] = useState<SessionInferenceOverride | null>(null);
  const [extraSources, setExtraSources] = useState<number | null>(null);

  const sessionKey = target?.sessionIds.join(',') ?? '';
  const from = target?.fromProjectId;

  // Start on the first project that isn't the current one.
  useEffect(() => {
    if (!target) return;
    const first = projects.find((p) => p.id !== target.fromProjectId);
    setDest(first ? first.id : null);
  }, [sessionKey]);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    // Only one chat has a single override to report; several may each have their own.
    if (target.sessionIds.length === 1) {
      void window.electronAPI.hermesChat
        .getSessionInference({ sessionId: target.sessionIds[0] })
        .then((snap) => {
          if (!cancelled) setOverride(snap.override);
        })
        .catch((): void => undefined);
    } else {
      setOverride(null);
    }
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  useEffect(() => {
    setExtraSources(null);
    if (!dest) return;
    let cancelled = false;
    // Not inspectSources: its catalog check reads every source file on the main thread.
    void window.electronAPI.projects
      .countSources({ projectId: dest })
      .then((count) => {
        if (!cancelled) setExtraSources(count);
      })
      .catch((): void => undefined);
    return () => {
      cancelled = true;
    };
  }, [dest]);

  // undefined when the chats come from several projects; null for No project.
  const fromProject: HermesProjectRecord | null | undefined =
    from === undefined ? undefined : from ? (projects.find((p) => p.id === from) ?? null) : null;
  const toProject = dest ? (projects.find((p) => p.id === dest) ?? null) : null;
  const unchanged = from !== undefined && (from ?? null) === dest;

  const effects = useMemo(
    () =>
      unchanged || !target
        ? []
        : moveEffects({
            agentName,
            from: fromProject,
            to: toProject,
            extraSources,
            inferenceBefore: effectiveInference(fromProject ?? null, override, status),
            inferenceAfter: effectiveInference(toProject, override, status),
            isDm: target.isDm,
          }),
    [unchanged, target, agentName, fromProject, toProject, extraSources, override, status]
  );

  if (!target) return null;

  const row = (project: HermesProjectRecord | null) => {
    const id = project?.id ?? null;
    const current = from !== undefined && (from ?? null) === id;
    const on = dest === id;
    return (
      <button
        key={id ?? 'none'}
        type="button"
        role="radio"
        aria-checked={on}
        disabled={busy || current}
        className={`wb-proj-menu-item wb-move-dest${on ? ' is-on' : ''}`}
        onClick={() => setDest(id)}
      >
        <span className="wb-proj-menu-check" aria-hidden="true">
          {on ? '✓' : ''}
        </span>
        <ProjectGlyph project={project} />
        <span className="wb-proj-copy">
          <span className="name" title={project?.name ?? 'No project'}>
            {project?.name ?? 'No project'}
          </span>
          <span className="path mono" title={project ? displayHostPath(project.hostPath) : undefined}>
            {project ? displayHostPath(project.hostPath) : 'No folder'}
          </span>
        </span>
        {current ? <span className="wb-move-current">{target.isDm ? 'Now' : 'Current'}</span> : null}
      </button>
    );
  };

  const verb = target.isDm ? 'Work in' : 'Move to';
  return (
    <Sheet
      open
      onClose={onCancel}
      busy={busy}
      titleId="wb-move-title"
      kicker={target.isDm ? 'Folder for this DM' : 'Move to project'}
      title={target.isDm ? `Where ${agentName} works` : `Move ${target.label}`}
      error={error}
      actions={
        <>
          <button
            type="button"
            className="wb-btn-solid"
            disabled={busy || unchanged}
            onClick={() => onMove(dest)}
          >
            {busy ? 'Moving…' : `${verb} ${toProject?.name ?? 'No project'}`}
          </button>
          <button type="button" className="wb-btn-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </>
      }
    >
      <div className="wb-move-list" role="radiogroup" aria-label="Destination">
        {projects.map((project) => row(project))}
        {row(null)}
      </div>
      {effects.length > 0 ? (
        <div className="wb-move-effects" aria-live="polite">
          <div className="wb-move-effects-head">What changes</div>
          {effects.map((effect) => (
            <div key={effect.kind} className={`wb-move-effect${effect.kind === 'cloud' ? ' is-warn' : ''}`}>
              <EffectIcon kind={effect.kind} />
              <span>{effect.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Sheet>
  );
};
