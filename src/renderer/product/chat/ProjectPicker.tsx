import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HermesProjectRecord } from '../../../shared/types/hermesChat';
import {
  displayHostPath,
  projectGlyph,
  projectGlyphColor,
} from './chatTelemetryFormat';
import {
  projectInferencePinClass,
  projectInferencePinTitle,
} from './ProjectSourcesRail';

const SEARCH_THRESHOLD = 8;

export interface ProjectPickerProps {
  projects: HermesProjectRecord[];
  activeProjectId: string | null;
  connecting?: boolean;
  /** `rail` = left-nav trigger; `chip` = composer instrument chip. */
  variant: 'rail' | 'chip';
  onSelectProject: (projectId: string) => void;
  onClearProject: () => void;
  onNewProject: () => void;
  /** Heading over the list, e.g. "Go to project" on the rail (ADR 0024 §3). */
  menuTitle?: string;
  /** Conversations per project id, with `none` for No project; shown beside each row. */
  counts?: Record<string, number>;
  /** Chip only: a word before the name, e.g. "Works in" for a DM's folder. */
  chipPrefix?: string;
  /** Accessible name and tooltip for the trigger. */
  triggerLabel?: string;
}

function sortByRecency(projects: HermesProjectRecord[]): HermesProjectRecord[] {
  return [...projects].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt) || 0;
    const bTime = Date.parse(b.updatedAt) || 0;
    if (bTime !== aTime) return bTime - aTime;
    return a.name.localeCompare(b.name);
  });
}

function GlyphWithPin({ project }: { project: HermesProjectRecord }) {
  const pinClass = projectInferencePinClass(project.inference);
  return (
    <span className="wb-glyph" style={{ background: projectGlyphColor(project.id) }}>
      {projectGlyph(project.name)}
      {pinClass ? (
        <span
          className={`wb-inf-pin ${pinClass}`}
          title={projectInferencePinTitle(project.inference)}
        />
      ) : null}
    </span>
  );
}

export const ProjectPicker: React.FC<ProjectPickerProps> = ({
  projects,
  activeProjectId,
  connecting = false,
  variant,
  onSelectProject,
  onClearProject,
  onNewProject,
  menuTitle,
  counts,
  chipPrefix,
  triggerLabel,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );

  const recentProjects = useMemo(() => sortByRecency(projects), [projects]);

  const showSearch = recentProjects.length > SEARCH_THRESHOLD;

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recentProjects;
    return recentProjects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.hostPath.toLowerCase().includes(q) ||
        displayHostPath(p.hostPath).toLowerCase().includes(q)
    );
  }, [recentProjects, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  useEffect(() => {
    if (open && showSearch) {
      searchRef.current?.focus();
    }
  }, [open, showSearch]);

  const toggle = () => {
    if (connecting) return;
    setOpen((wasOpen) => {
      if (wasOpen) {
        setQuery('');
        return false;
      }
      return true;
    });
  };

  const pickNone = () => {
    onClearProject();
    close();
  };

  const pickProject = (projectId: string) => {
    onSelectProject(projectId);
    close();
  };

  const pickNew = () => {
    close();
    onNewProject();
  };

  const menu = open ? (
    <div className="wb-proj-menu" role="listbox" aria-label={menuTitle ?? 'Choose project'}>
      {menuTitle ? <div className="wb-proj-menu-title">{menuTitle}</div> : null}
      {showSearch ? (
        <div className="wb-proj-menu-search">
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            aria-label="Search projects"
          />
        </div>
      ) : null}
      <div className="wb-proj-menu-list">
        <button
          type="button"
          role="option"
          aria-selected={activeProjectId === null}
          className={`wb-proj-menu-item${activeProjectId === null ? ' is-on' : ''}`}
          onClick={pickNone}
        >
          <span className="wb-proj-menu-check" aria-hidden="true">
            {activeProjectId === null ? '✓' : ''}
          </span>
          <span className="wb-glyph is-none" aria-hidden="true">
            —
          </span>
          <span className="wb-proj-copy">
            <span className="name">No project</span>
          </span>
          {counts ? <span className="wb-proj-count">{counts.none ?? 0}</span> : null}
        </button>
        {filteredProjects.map((project) => {
          const on = project.id === activeProjectId;
          return (
            <button
              key={project.id}
              type="button"
              role="option"
              aria-selected={on}
              className={`wb-proj-menu-item${on ? ' is-on' : ''}`}
              onClick={() => pickProject(project.id)}
            >
              <span className="wb-proj-menu-check" aria-hidden="true">
                {on ? '✓' : ''}
              </span>
              <GlyphWithPin project={project} />
              <span className="wb-proj-copy">
                <span className="name">{project.name}</span>
                <span className="path mono">{displayHostPath(project.hostPath)}</span>
              </span>
              {counts ? <span className="wb-proj-count">{counts[project.id] ?? 0}</span> : null}
            </button>
          );
        })}
        {filteredProjects.length === 0 && query.trim() ? (
          <div className="wb-proj-menu-empty">No matching projects</div>
        ) : null}
      </div>
      <div className="wb-proj-menu-footer">
        <div className="wb-proj-menu-sep" role="separator" />
        <button
          type="button"
          className="wb-proj-menu-action"
          disabled={connecting}
          onClick={pickNew}
        >
          New project…
        </button>
      </div>
    </div>
  ) : null;

  if (variant === 'chip') {
    return (
      <div className="wb-proj-picker wb-proj-picker--chip" ref={rootRef}>
        <button
          type="button"
          className="wb-chip"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={connecting}
          aria-label={triggerLabel}
          title={
            triggerLabel ??
            (activeProject
              ? `${activeProject.name} · ${displayHostPath(activeProject.hostPath)}`
              : 'No project')
          }
          onClick={toggle}
        >
          {chipPrefix ? <span className="wb-chip-prefix">{chipPrefix}</span> : null}
          {activeProject ? (
            <>
              <b>{activeProject.name}</b>
              <span className="mono">{displayHostPath(activeProject.hostPath)}</span>
            </>
          ) : (
            'No project'
          )}
        </button>
        {menu}
      </div>
    );
  }

  return (
    <div className="wb-proj-picker" ref={rootRef}>
      <button
        type="button"
        className="wb-proj-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={triggerLabel ?? 'Current project'}
        disabled={connecting}
        title={triggerLabel ?? 'Current project'}
        onClick={toggle}
      >
        {activeProject ? (
          <GlyphWithPin project={activeProject} />
        ) : (
          <span className="wb-glyph is-none" aria-hidden="true">
            —
          </span>
        )}
        <span className="wb-proj-copy">
          <span className="name">{activeProject?.name ?? 'No project'}</span>
          {activeProject ? (
            <span className="path mono">{displayHostPath(activeProject.hostPath)}</span>
          ) : null}
        </span>
        <span className="wb-proj-chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {menu}
    </div>
  );
};
