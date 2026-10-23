import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import { ProjectPicker } from '../ProjectPicker';

const projects: HermesProjectRecord[] = [
  {
    id: 'p1',
    name: 'Job Search',
    hostPath: '/Users/ada/Documents/Job Search',
    containerPath: '/opt/projects/job-search',
    slug: 'job-search',
    kind: 'host-folder',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  },
  {
    id: 'p2',
    name: 'Notes',
    hostPath: '/Users/ada/Documents/Boundary Notes',
    containerPath: '/opt/projects/notes',
    slug: 'notes',
    kind: 'host-folder',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
];

describe('ProjectPicker', () => {
  afterEach(() => {
    cleanup();
  });

  it('opens No project, recents, and New project from the rail trigger', () => {
    const onSelectProject = vi.fn();
    const onClearProject = vi.fn();
    const onNewProject = vi.fn();

    render(
      <ProjectPicker
        variant="rail"
        projects={projects}
        activeProjectId="p1"
        onSelectProject={onSelectProject}
        onClearProject={onClearProject}
        onNewProject={onNewProject}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Current project' }));
    fireEvent.click(screen.getByRole('option', { name: /No project/ }));
    expect(onClearProject).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Current project' }));
    fireEvent.click(screen.getByRole('option', { name: /Notes/ }));
    expect(onSelectProject).toHaveBeenCalledWith('p2');

    fireEvent.click(screen.getByRole('button', { name: 'Current project' }));
    fireEvent.click(screen.getByRole('button', { name: 'New project…' }));
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

  it('exposes the same menu from the composer chip', () => {
    const onClearProject = vi.fn();
    render(
      <ProjectPicker
        variant="chip"
        projects={projects}
        activeProjectId={null}
        onSelectProject={vi.fn()}
        onClearProject={onClearProject}
        onNewProject={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'No project' }));
    expect(screen.getByRole('option', { name: /Job Search/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New project…' })).toBeTruthy();
  });

  it('shows a quiet pin only when the project is not inherit', () => {
    const pinned: HermesProjectRecord[] = [
      {
        ...projects[0],
        inference: { mode: 'local', modelId: 'qwen3:14b' },
      },
      {
        ...projects[1],
        inference: { mode: 'inherit' },
      },
    ];
    render(
      <ProjectPicker
        variant="rail"
        projects={pinned}
        activeProjectId="p1"
        onSelectProject={vi.fn()}
        onClearProject={vi.fn()}
        onNewProject={vi.fn()}
      />
    );
    expect(document.querySelectorAll('.wb-inf-pin.is-local')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Current project' }));
    expect(document.querySelectorAll('.wb-inf-pin.is-local')).toHaveLength(2);
    expect(document.querySelector('.wb-inf-pin.is-cloud')).toBeNull();
  });

  it('shows search once there are more than eight projects', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...projects[0],
      id: `p${i}`,
      name: `Project ${i}`,
      slug: `project-${i}`,
      updatedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));

    render(
      <ProjectPicker
        variant="rail"
        projects={many}
        activeProjectId="p0"
        onSelectProject={vi.fn()}
        onClearProject={vi.fn()}
        onNewProject={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Current project' }));
    expect(screen.getByLabelText('Search projects')).toBeTruthy();
    const list = document.querySelector('.wb-proj-menu-list');
    const footer = document.querySelector('.wb-proj-menu-footer');
    expect(list?.contains(screen.getByRole('option', { name: /Project 0/ }))).toBe(
      true
    );
    expect(footer?.contains(screen.getByRole('button', { name: 'New project…' }))).toBe(
      true
    );
    expect(list?.contains(screen.getByRole('button', { name: 'New project…' }))).toBe(
      false
    );
  });
});
