import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectGlyph } from '../ProjectGlyph';

const project = { id: 'p1', name: 'job search' };
const glyph = (container: HTMLElement) => container.querySelector('.wb-glyph') as HTMLElement;

describe('ProjectGlyph', () => {
  it('draws the initial on the project colour, hidden from screen readers', () => {
    const { container } = render(<ProjectGlyph project={project} />);
    const el = glyph(container);
    expect(el.textContent).toBe('J');
    expect(el.className).toBe('wb-glyph');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.style.background).not.toBe('');
  });

  it('draws one No project glyph, inline or not', () => {
    const { container, rerender } = render(<ProjectGlyph project={null} />);
    expect(glyph(container).className).toBe('wb-glyph is-none');
    expect(glyph(container).textContent).toBe('—');
    rerender(<ProjectGlyph project={null} inline size={12} />);
    expect(glyph(container).className).toBe('wb-glyph wb-glyph-inline is-none');
    expect(glyph(container).textContent).toBe('—');
    expect(glyph(container).style.width).toBe('12px');
  });

  it('shows the inference pin only when asked and the project pins a default', () => {
    const local = { ...project, inference: { mode: 'local' as const } };
    const { container, rerender } = render(<ProjectGlyph project={local} />);
    expect(container.querySelector('.wb-inf-pin')).toBeNull();
    rerender(<ProjectGlyph project={local} pin />);
    expect(container.querySelector('.wb-inf-pin.is-local')?.getAttribute('title')).toBe(
      'Local default'
    );
    rerender(<ProjectGlyph project={{ ...project, inference: { mode: 'openrouter' } }} pin />);
    expect(container.querySelector('.wb-inf-pin.is-cloud')?.getAttribute('title')).toBe(
      'OpenRouter default'
    );
    rerender(<ProjectGlyph project={{ ...project, inference: { mode: 'inherit' } }} pin />);
    expect(container.querySelector('.wb-inf-pin')).toBeNull();
  });

  it('greys out a folder that cannot become a project but keeps its initial', () => {
    const { container } = render(<ProjectGlyph project={project} muted />);
    expect(glyph(container).className).toBe('wb-glyph is-none');
    expect(glyph(container).textContent).toBe('J');
    expect(glyph(container).style.background).toBe('');
  });
});
