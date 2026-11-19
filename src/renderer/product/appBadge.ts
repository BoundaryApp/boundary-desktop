import { useEffect } from 'react';
import { overlayLabel, type AppBadge } from '../../shared/appBadge';

const OVERLAY_SIZE = 32;
const FALLBACK_BRAND = '#5b56d6';

const isWindowsPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

/**
 * The Windows taskbar overlay for `count`: a brand-coloured disc with the count, drawn at 32px
 * so it stays sharp at 200% scaling. Null when the canvas can't draw.
 */
function drawOverlay(count: number, doc: Document = document): string | null {
  const canvas = doc.createElement('canvas');
  canvas.width = OVERLAY_SIZE;
  canvas.height = OVERLAY_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const brand =
    getComputedStyle(doc.documentElement).getPropertyValue('--brand').trim() || FALLBACK_BRAND;
  const r = OVERLAY_SIZE / 2;
  ctx.fillStyle = brand;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${count > 9 ? 17 : 21}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(overlayLabel(count), r, r + 1);
  return canvas.toDataURL('image/png');
}

/** The badge to send for `count`; Windows adds the overlay image it shows instead of a count. */
export function appBadgeFor(
  count: number,
  windows = isWindowsPlatform(),
  draw: (count: number) => string | null = drawOverlay
): AppBadge {
  if (!windows || count === 0) return { count };
  const overlay = draw(count);
  return overlay ? { count, overlay } : { count };
}

function send(count: number): void {
  void window.electronAPI.appBadge.set(appBadgeFor(count)).catch(() => {
    /* the icon badge is a hint; the rail count still shows */
  });
}

/**
 * Keep the app icon's badge at `count` while the caller is mounted, and clear it on unmount,
 * so the badge never outlives the count the rail shows.
 */
export function useAppBadge(count: number): void {
  useEffect(() => {
    send(count);
  }, [count]);
  useEffect(() => () => send(0), []);
}
