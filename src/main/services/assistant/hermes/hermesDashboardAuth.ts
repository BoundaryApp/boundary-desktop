import {
  resolveDashboardCredentials,
  resolveHermesStackEndpoints,
  type HermesDashboardCredentials,
} from './hermesEndpoints';

export interface HermesDashboardSession {
  cookieHeader: string;
  ticket: string;
  dashboardBaseUrl: string;
}

export function basicAuthHeaderForTest(creds: HermesDashboardCredentials): string {
  return basicAuthHeader(creds);
}

function basicAuthHeader(creds: HermesDashboardCredentials): string {
  return `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`;
}

function collectSetCookie(res: Response): string {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const parts: string[] = [];
  if (typeof headers.getSetCookie === 'function') {
    for (const c of headers.getSetCookie()) {
      const pair = c.split(';')[0]?.trim();
      if (pair) parts.push(pair);
    }
  } else {
    const single = res.headers.get('set-cookie');
    if (single) {
      for (const c of single.split(/,(?=\s*[^;=]+=)/)) {
        const pair = c.split(';')[0]?.trim();
        if (pair) parts.push(pair);
      }
    }
  }
  return parts.join('; ');
}

export interface HermesDashboardLogin {
  cookieHeader: string;
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

  const cookieHeader = collectSetCookie(loginRes);

  if (!loginRes.ok) {
    const text = await loginRes.text().catch(() => '');
    throw new Error(
      `Dashboard password-login failed (${loginRes.status}): ${text.slice(0, 200) || loginRes.statusText}`
    );
  }

  if (!cookieHeader) {
    throw new Error('Dashboard password-login returned no session cookie');
  }

  return { cookieHeader, dashboardBaseUrl };
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
