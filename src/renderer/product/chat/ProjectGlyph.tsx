import React from 'react';
import type { HermesProjectRecord } from '../../../shared/types/hermesChat';
import { inferenceSlotLabel } from '../../../shared/inferenceDisplay';
import { projectGlyph, projectGlyphColor } from './chatTelemetryFormat';

interface ProjectGlyphProps {
  /** null draws the No project glyph. */
  project: Pick<HermesProjectRecord, 'id' | 'name' | 'inference'> | null;
  /** The 14px glyph that sits in a line of text (breadcrumbs, list rows). */
  inline?: boolean;
  /** Width and height in px, for an inline glyph drawn smaller or larger than 14. */
  size?: number;
  /** Show the dot for a project that pins its own inference default. */
  pin?: boolean;
  /** Grey, for a folder that can't become a project. */
  muted?: boolean;
}

/**
 * A project's coloured initial. It is decorative: the project's name is always beside it,
 * so screen readers skip it.
 */
export const ProjectGlyph: React.FC<ProjectGlyphProps> = ({
  project,
  inline = false,
  size,
  pin = false,
  muted = false,
}) => {
  const none = !project || muted;
  const className = `wb-glyph${inline ? ' wb-glyph-inline' : ''}${none ? ' is-none' : ''}`;
  const dimensions = size ? { width: size, height: size } : undefined;
  if (!project) {
    return (
      <span className={className} style={dimensions} aria-hidden="true">
        —
      </span>
    );
  }
  const mode = project.inference?.mode ?? 'inherit';
  return (
    <span
      className={className}
      style={muted ? dimensions : { background: projectGlyphColor(project.id), ...dimensions }}
      aria-hidden="true"
    >
      {projectGlyph(project.name)}
      {pin && mode !== 'inherit' ? (
        <span
          className={`wb-inf-pin ${mode === 'local' ? 'is-local' : 'is-cloud'}`}
          title={`${inferenceSlotLabel(mode)} default`}
        />
      ) : null}
    </span>
  );
};
