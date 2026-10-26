import crypto from 'node:crypto';

// Dashboard board links: the stack's "Dashboard links" contract (docs/extending.md there;
// CR 0012 here). Pure, so it runs outside Electron.

/** How far ahead a handoff code expires. The stack accepts at most 60 s. */
const HANDOFF_TTL_S = 30;

export function boardPath(opts: {
  taskId?: string | null;
  board?: string | null;
  embed: boolean;
}): string {
  const q = new URLSearchParams();
  if (opts.embed) q.set('embed', '1');
  if (opts.taskId) {
    q.set('task', opts.taskId);
    if (opts.board) q.set('board', opts.board);
  }
  const qs = q.toString();
  return qs ? `/kanban?${qs}` : '/kanban';
}

/** `<payload>.<signature>`, both base64url: the stack's handoff code, version 1. */
export function mintHandoffCode(
  secret: string,
  next: string,
  nowS: number,
  nonce: string = crypto.randomBytes(18).toString('base64url')
): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, nonce, exp: nowS + HANDOFF_TTL_S, next })
  ).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/** True for the dashboard's board page, the only page the embedded view may show. */
export function isBoardUrl(url: string, dashboardBaseUrl: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.origin === new URL(dashboardBaseUrl).origin &&
      (u.pathname === '/kanban' || u.pathname.startsWith('/kanban/'))
    );
  } catch {
    return false;
  }
}

/**
 * The URL to open a dashboard path in the system browser: a sign-in link when the stack has a
 * handoff secret, otherwise the plain path (the browser may then show the dashboard's login).
 * Never log the result: a handoff code is a credential until it's used.
 */
export function browserUrlFor(
  dashboardBaseUrl: string,
  next: string,
  secret: string | null,
  nowS: number
): string {
  if (!secret) return `${dashboardBaseUrl}${next}`;
  const code = mintHandoffCode(secret, next, nowS);
  return `${dashboardBaseUrl}/auth/handoff?code=${encodeURIComponent(code)}`;
}
