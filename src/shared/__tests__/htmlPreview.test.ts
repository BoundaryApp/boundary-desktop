import { describe, expect, it } from 'vitest';
import {
  PREVIEW_CSP,
  PREVIEW_MAX_BYTES,
  PROJECTS_CONTAINER_ROOT,
  isPreviewablePath,
  previewSrcdoc,
  previewablePathsOf,
} from '../htmlPreview';

const META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;

describe('htmlPreview', () => {
  it('exports the limits and root', () => {
    expect(PREVIEW_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(PROJECTS_CONTAINER_ROOT).toBe('/opt/projects');
    expect(PREVIEW_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:"
    );
  });

  it('puts the CSP meta first', () => {
    expect(previewSrcdoc('<p>hi</p>')).toBe(`${META}<p>hi</p>`);
  });

  it('keeps a doctype ahead of the meta', () => {
    expect(previewSrcdoc('<!DOCTYPE html>\n<html><head></head></html>')).toBe(
      `<!DOCTYPE html>\n${META}<html><head></head></html>`
    );
  });

  it('skips leading whitespace and a BOM before the doctype', () => {
    expect(previewSrcdoc('\uFEFF  <!doctype html><p>x</p>')).toBe(
      `<!doctype html>${META}<p>x</p>`
    );
  });

  it('strips a BOM when there is no doctype', () => {
    expect(previewSrcdoc('\uFEFF<p>x</p>')).toBe(`${META}<p>x</p>`);
  });

  it('accepts .html and .htm in any case only', () => {
    expect(['a.html', 'b.HTM', 'c.Html'].map(isPreviewablePath)).toEqual([true, true, true]);
    expect(['a.html.txt', 'a.md', 'html'].map(isPreviewablePath)).toEqual([false, false, false]);
  });

  it('lists previewable files under /opt/projects only', () => {
    expect(
      previewablePathsOf([
        '/opt/projects/scratch/demo.html',
        '/opt/projects/scratch/demo.html',
        '/opt/projects/a/../../etc/x.html',
        '/opt/data/x.html',
        'scratch/rel.html',
        '/opt/projects/scratch/notes.md',
      ])
    ).toEqual(['/opt/projects/scratch/demo.html']);
  });
});
