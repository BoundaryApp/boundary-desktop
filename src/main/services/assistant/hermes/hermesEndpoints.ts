import { getStackEndpoints, getStackFiles } from '../../stackHost/activeStack';
import { readStackEnv } from '../stackEnv';

export interface HermesDashboardCredentials {
  username: string;
  password: string;
}

export interface HermesStackEndpoints {
  dashboardBaseUrl: string;
  apiBaseUrl: string;
  webuiBaseUrl: string;
}

function readProjectEnv(): Promise<Record<string, string>> {
  return readStackEnv(getStackFiles(), 'stack', '.env');
}

export function resolveHermesStackEndpoints(): HermesStackEndpoints {
  const endpoints = getStackEndpoints();
  return {
    dashboardBaseUrl: endpoints.url('dashboard'),
    apiBaseUrl: endpoints.url('apiServer', '/v1'),
    webuiBaseUrl: endpoints.url('webui'),
  };
}

export async function resolveDashboardCredentials(): Promise<HermesDashboardCredentials | null> {
  const env = await readProjectEnv();
  const username = env.HERMES_DASHBOARD_USER || 'admin';
  const password = env.HERMES_DASHBOARD_PASSWORD || '';
  if (!password) return null;
  return { username, password };
}

/**
 * The secret that signs one-time dashboard sign-in links (`GET /auth/handoff`, the stack's
 * docs/extending.md). The stack's route answers 404 without one of at least 32 characters, so a
 * shorter value counts as missing.
 */
export async function resolveDashboardHandoffSecret(): Promise<string | null> {
  const secret = (await readProjectEnv()).HERMES_DASHBOARD_HANDOFF_SECRET?.trim() ?? '';
  return secret.length >= 32 ? secret : null;
}

/** Files that may hold the api-server profile's key, as `[location, path]`, first match wins. */
const API_SERVER_ENV_FILES = [
  ['data', 'hermes/profiles/api-server/.env'],
  ['stack', 'compose/hermes/api-server.env'],
] as const;

export async function resolveApiServerKey(): Promise<string | null> {
  const files = getStackFiles();
  for (const [location, rel] of API_SERVER_ENV_FILES) {
    const key = (await readStackEnv(files, location, rel)).API_SERVER_KEY?.trim();
    if (key) return key;
  }
  return (await readProjectEnv()).API_SERVER_KEY?.trim() || null;
}
