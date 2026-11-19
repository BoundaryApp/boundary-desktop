/**
 * Decides whether a frame navigation in the main window must be cancelled. A page preview
 * runs in a sandboxed srcdoc iframe, which inherits the app's `frame-src` and that allows
 * http(s)://localhost:*. Without this check, the page could send its own frame to a local
 * service with `location = ...` or a meta refresh. Sandboxed frames report the opaque
 * origin 'null'; frames with a real origin (the board webview, app frames) are not affected.
 */
export function shouldBlockSandboxedFrameNavigation(details: {
  isMainFrame: boolean;
  url: string;
  frameOrigin: string | null | undefined;
}): boolean {
  if (details.isMainFrame) return false;
  if (details.frameOrigin !== 'null') return false;
  return details.url !== 'about:srcdoc';
}
