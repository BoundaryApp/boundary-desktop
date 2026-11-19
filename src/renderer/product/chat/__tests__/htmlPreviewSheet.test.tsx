import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { HermesHtmlPreviewResult } from '../../../../shared/types/hermesChat';
import { previewSrcdoc } from '../../../../shared/htmlPreview';

const read = vi.fn();

stubElectronAPI({
  hermesChat: {
    readHtmlPreview: (...args: unknown[]) => read(...args),
  },
});

import { HtmlPreviewSheet } from '../HtmlPreviewSheet';

function deferred() {
  let resolve!: (value: HermesHtmlPreviewResult) => void;
  const promise = new Promise<HermesHtmlPreviewResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('HtmlPreviewSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the page in a scripts-only sandbox with the CSP first', async () => {
    read.mockResolvedValue({ success: true, html: '<p>hi</p>', name: 'd.html' });
    render(<HtmlPreviewSheet containerPath="/opt/projects/s/d.html" onClose={vi.fn()} />);
    const frame = await screen.findByTitle('d.html');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toBe(previewSrcdoc('<p>hi</p>'));
    expect(read).toHaveBeenCalledWith({ containerPath: '/opt/projects/s/d.html' });
  });

  it('shows the error and no frame when the read fails', async () => {
    read.mockResolvedValue({ success: false, error: 'That file no longer exists.' });
    render(<HtmlPreviewSheet containerPath="/opt/projects/s/gone.html" onClose={vi.fn()} />);
    expect(await screen.findByText('That file no longer exists.')).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('ignores a late result after the path changes', async () => {
    const first = deferred();
    const second = deferred();
    read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(
      <HtmlPreviewSheet containerPath="/opt/projects/s/a.html" onClose={vi.fn()} />
    );
    rerender(<HtmlPreviewSheet containerPath="/opt/projects/s/b.html" onClose={vi.fn()} />);
    second.resolve({ success: true, html: '<p>b</p>', name: 'b.html' });
    expect(await screen.findByTitle('b.html')).toBeTruthy();
    first.resolve({ success: true, html: '<p>a</p>', name: 'a.html' });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByTitle('a.html')).toBeNull();
    expect(screen.getByTitle('b.html').getAttribute('srcdoc')).toBe(previewSrcdoc('<p>b</p>'));
  });

  it('shows Loading… again when the same page is reopened after closing', async () => {
    read.mockResolvedValueOnce({ success: true, html: '<p>old</p>', name: 'd.html' });
    const { rerender } = render(
      <HtmlPreviewSheet containerPath="/opt/projects/s/d.html" onClose={vi.fn()} />
    );
    await screen.findByTitle('d.html');
    rerender(<HtmlPreviewSheet containerPath={null} onClose={vi.fn()} />);
    const pending = deferred();
    read.mockReturnValueOnce(pending.promise);
    rerender(<HtmlPreviewSheet containerPath="/opt/projects/s/d.html" onClose={vi.fn()} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('names the sheet by the file while loading, and renders nothing without a path', async () => {
    const pending = deferred();
    read.mockReturnValue(pending.promise);
    const { container, rerender } = render(
      <HtmlPreviewSheet containerPath="/opt/projects/s/plan.html" onClose={vi.fn()} />
    );
    expect(screen.getByText('plan.html')).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
    pending.resolve({ success: true, html: '', name: 'plan.html' });
    await screen.findByTitle('plan.html');
    rerender(<HtmlPreviewSheet containerPath={null} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('offers Reveal only when given a handler', async () => {
    read.mockResolvedValue({ success: true, html: 'x', name: 'd.html' });
    const reveal = vi.fn();
    const { rerender } = render(
      <HtmlPreviewSheet containerPath="/opt/projects/s/d.html" onClose={vi.fn()} reveal={reveal} />
    );
    await screen.findByTitle('d.html');
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(reveal).toHaveBeenCalledTimes(1);
    rerender(<HtmlPreviewSheet containerPath="/opt/projects/s/d.html" onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull();
  });
});
