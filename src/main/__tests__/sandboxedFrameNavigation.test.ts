import { describe, expect, it } from 'vitest';
import { shouldBlockSandboxedFrameNavigation } from '../sandboxedFrameNavigation';

describe('shouldBlockSandboxedFrameNavigation', () => {
  it('blocks an opaque-origin subframe navigating to localhost', () => {
    expect(
      shouldBlockSandboxedFrameNavigation({
        isMainFrame: false,
        url: 'http://localhost:8643/health',
        frameOrigin: 'null',
      }),
    ).toBe(true);
  });

  it('blocks an opaque-origin subframe navigating to a public site', () => {
    expect(
      shouldBlockSandboxedFrameNavigation({
        isMainFrame: false,
        url: 'https://example.com/',
        frameOrigin: 'null',
      }),
    ).toBe(true);
  });

  it('allows the srcdoc load itself', () => {
    expect(
      shouldBlockSandboxedFrameNavigation({
        isMainFrame: false,
        url: 'about:srcdoc',
        frameOrigin: 'null',
      }),
    ).toBe(false);
  });

  it('allows main frame navigation', () => {
    expect(
      shouldBlockSandboxedFrameNavigation({
        isMainFrame: true,
        url: 'http://localhost:5173/',
        frameOrigin: 'null',
      }),
    ).toBe(false);
  });

  it('allows a subframe with a real origin', () => {
    expect(
      shouldBlockSandboxedFrameNavigation({
        isMainFrame: false,
        url: 'http://localhost:8643/board',
        frameOrigin: 'http://localhost:8643',
      }),
    ).toBe(false);
  });

  it('allows a subframe whose origin is unknown', () => {
    expect(
      shouldBlockSandboxedFrameNavigation({
        isMainFrame: false,
        url: 'http://localhost:8643/board',
        frameOrigin: null,
      }),
    ).toBe(false);
  });
});
