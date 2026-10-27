import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HermesProjectRecord } from '../../../shared/types/hermesChat';
import { newestFirst } from '../../../shared/utils/sort';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { displayHostPath } from './chatTelemetryFormat';
import { ProjectGlyph } from './ProjectGlyph';

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
  return [...projects].sort((a, b) => newestFirst(a, b) || a.name.localeCompare(b.name));
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
    if (open && showSearch) {
      searchRef.current?.focus();
    }
  }, [open, showSearch]);

  const onOpenChange = (next: boolean) => {
    if (!next) close();
    else if (!connecting) setOpen(true);
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

  const menu = (
    <PopoverContent
      className="wb-proj-menu"
      role="listbox"
      aria-label={menuTitle ?? 'Choose project'}
      side={variant === 'chip' ? 'top' : 'bottom'}
      align="start"
      sideOffset={variant === 'chip' ? 6 : 4}
    >
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
          <ProjectGlyph project={null} />
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
              title={`${project.name} · ${displayHostPath(project.hostPath)}`}
            >
              <span className="wb-proj-menu-check" aria-hidden="true">
                {on ? '✓' : ''}
              </span>
              <ProjectGlyph project={project} pin />
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
    </PopoverContent>
  );

  if (variant === 'chip') {
    return (
      <div className="wb-proj-picker wb-proj-picker--chip">
        <Popover open={open} onOpenChange={onOpenChange}>
          <PopoverTrigger>
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
          </PopoverTrigger>
          {menu}
        </Popover>
      </div>
    );
  }

  return (
    <div className="wb-proj-picker">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger>
          <button
            type="button"
            className="wb-proj-trigger"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={triggerLabel ?? 'Current project'}
            disabled={connecting}
            title={
              activeProject
                ? `${activeProject.name} · ${displayHostPath(activeProject.hostPath)}`
                : 'No project'
            }
          >
            <ProjectGlyph project={activeProject} pin />
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
        </PopoverTrigger>
        {menu}
      </Popover>
    </div>
  );
};
