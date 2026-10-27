import {
  resolveDashboardCredentials,
  resolveHermesStackEndpoints,
} from './hermesEndpoints';

export interface HermesDashboardSession {
  cookieHeader: string;
  ticket: string;
  dashboardBaseUrl: string;
}

function rawSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single ? single.split(/,(?=\s*[^;=]+=)/) : [];
}

/** One `Set-Cookie` from the dashboard, with the attributes a browser session needs. */
export interface DashboardCookie {
  name: string;
  value: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'no_restriction' | 'unspecified';
  /** Seconds from now, or null for a session cookie. */
  maxAgeS: number | null;
}

export function parseSetCookie(raw: string): DashboardCookie | null {
  const [pair, ...attrs] = raw.split(';');
  const eq = pair?.indexOf('=') ?? -1;
  if (!pair || eq <= 0) return null;
  const cookie: DashboardCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: 'unspecified',
    maxAgeS: null,
  };
  for (const attr of attrs) {
    const [rawKey, ...rest] = attr.split('=');
    const key = rawKey?.trim().toLowerCase();
    const val = rest.join('=').trim();
    if (key === 'path' && val) cookie.path = val;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'max-age' && /^-?\d+$/.test(val)) cookie.maxAgeS = Number(val);
    else if (key === 'samesite') {
      const s = val.toLowerCase();
      cookie.sameSite = s === 'lax' ? 'lax' : s === 'strict' ? 'strict' : s === 'none' ? 'no_restriction' : 'unspecified';
    }
  }
  return cookie;
}

export interface HermesDashboardLogin {
  cookieHeader: string;
  /** The same cookies with their attributes, for copying into a browser session. */
  cookies: DashboardCookie[];
  dashboardBaseUrl: string;
}

/**
 * Log in to the dashboard and return its session cookie, for REST calls and ticket minting.
 * The cookie and the basic-auth secret stay in the main process.
 *
 * Hermes gated basic-auth login is POST /auth/password-login with
 * `{ provider: "basic", username, password }` — not /api/auth/login.
 */
export async function loginToDashboard(): Promise<HermesDashboardLogin> {
  const { dashboardBaseUrl } = resolveHermesStackEndpoints();
  const creds = resolveDashboardCredentials();
  if (!creds) {
    throw new Error(
      'Dashboard credentials missing. Set HERMES_DASHBOARD_PASSWORD in the assistant project .env.'
    );
  }

  const loginRes = await fetch(`${dashboardBaseUrl}/auth/password-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      provider: 'basic',
      username: creds.username,
      password: creds.password,
    }),
  });

  const cookies = rawSetCookies(loginRes)
    .map(parseSetCookie)
    .filter((c): c is DashboardCookie => c !== null && c.maxAgeS !== 0);
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  if (!loginRes.ok) {
    const text = await loginRes.text().catch(() => '');
    throw new Error(
      `Dashboard password-login failed (${loginRes.status}): ${text.slice(0, 200) || loginRes.statusText}`
    );
  }

  if (!cookieHeader) {
    throw new Error('Dashboard password-login returned no session cookie');
  }

  return { cookieHeader, cookies, dashboardBaseUrl };
}

/** Mint a single-use WS ticket via the dashboard REST surface. */
export async function mintDashboardWsTicket(): Promise<HermesDashboardSession> {
  const { cookieHeader, dashboardBaseUrl } = await loginToDashboard();
  const ticketRes = await fetch(`${dashboardBaseUrl}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Cookie: cookieHeader,
    },
  });

  if (!ticketRes.ok) {
    const text = await ticketRes.text().catch(() => '');
    throw new Error(
      `ws-ticket failed (${ticketRes.status}): ${text.slice(0, 200) || ticketRes.statusText}`
    );
  }

  const body = (await ticketRes.json()) as { ticket?: string; ttl_seconds?: number };
  if (!body.ticket) {
    throw new Error('ws-ticket response missing ticket');
  }

  return {
    cookieHeader,
    ticket: body.ticket,
    dashboardBaseUrl,
  };
}
