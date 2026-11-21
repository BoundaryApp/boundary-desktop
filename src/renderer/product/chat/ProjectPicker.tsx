import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { HermesProjectRecord } from '../../../shared/types/hermesChat';
import { newestFirst } from '../../../shared/utils/sort';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { displayHostPath } from './chatTelemetryFormat';
import { ProjectGlyph } from './ProjectGlyph';
import { StackCapabilityNote, useStackCapability } from '../stackCapabilities';
import { Input } from '../../components/ui/input';
import { Listbox, ListboxOption } from '../../components/ui/listbox';
import { useListNavigation } from '../../components/ui/use-list-navigation';

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
  const hostFolders = useStackCapability('hostFolders');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

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

  // Options are No project, then the matching projects. The keyboard starts on the current
  // project, and on the first match once a search narrows the list.
  const options = useMemo(
    () => [null, ...filteredProjects.map((p) => p.id)] as (string | null)[],
    [filteredProjects]
  );

  useEffect(() => {
    if (!open) return;
    if (query.trim()) {
      setActive(filteredProjects.length > 0 ? 1 : 0);
    } else {
      setActive(Math.max(0, options.indexOf(activeProjectId)));
    }
    // Only on opening and on a new search: the arrows own `active` in between.
  }, [open, query]);


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

  const pickAt = (index: number) => {
    const id = options[index];
    if (id === undefined) return;
    if (id === null) pickNone();
    else pickProject(id);
  };

  const nav = useListNavigation({
    id: listId,
    open,
    count: options.length,
    active,
    onActiveChange: setActive,
    onPick: pickAt,
  });

  const pickNew = () => {
    close();
    onNewProject();
  };

  const title = menuTitle ?? 'Choose project';
  const menu = (
    <PopoverContent
      className="wb-proj-menu"
      aria-label={title}
      side={variant === 'chip' ? 'top' : 'bottom'}
      align="start"
      sideOffset={variant === 'chip' ? 6 : 4}
      // The search field takes focus when there is one, otherwise the list.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        (showSearch ? searchRef.current : listRef.current)?.focus();
      }}
    >
      {menuTitle ? <div className="wb-proj-menu-title">{menuTitle}</div> : null}
      {showSearch ? (
        <div className="wb-proj-menu-search">
          <Input
            size="sm"
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            aria-label="Search projects"
            {...nav.fieldProps}
          />
        </div>
      ) : null}
      <Listbox
        ref={listRef}
        id={listId}
        marks
        aria-label={title}
        className="wb-proj-menu-list wb-list-inset"
        {...(showSearch ? {} : nav.listProps)}
      >
        <ListboxOption
          id={nav.optionId(0)}
          selected={activeProjectId === null}
          active={active === 0}
          onPick={pickNone}
          icon={<ProjectGlyph project={null} inline />}
          hint={counts ? String(counts.none ?? 0) : undefined}
        >
          No project
        </ListboxOption>
        {filteredProjects.map((project, i) => (
          <ListboxOption
            key={project.id}
            id={nav.optionId(i + 1)}
            selected={project.id === activeProjectId}
            active={active === i + 1}
            onPick={() => pickProject(project.id)}
            title={`${project.name} · ${displayHostPath(project.hostPath)}`}
            icon={<ProjectGlyph project={project} inline pin />}
            description={<span className="mono">{displayHostPath(project.hostPath)}</span>}
            hint={counts ? String(counts[project.id] ?? 0) : undefined}
          >
            {project.name}
          </ListboxOption>
        ))}
      </Listbox>
      {filteredProjects.length === 0 && query.trim() ? (
        <div className="wb-proj-menu-empty">No matching projects</div>
      ) : null}
      <div className="wb-proj-menu-footer">
        <div className="wb-proj-menu-sep" role="separator" />
        {hostFolders ? (
          <button
            type="button"
            className="wb-proj-menu-action"
            disabled={connecting}
            onClick={pickNew}
          >
            New project…
          </button>
        ) : (
          <StackCapabilityNote capability="hostFolders" size="sm" />
        )}
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
