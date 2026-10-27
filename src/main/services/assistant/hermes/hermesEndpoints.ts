import path from 'node:path';
import { resolveActiveAssistantDataRoot, tryResolveAssistantRoot } from '../resolveAssistantRoot';
import { getStoredAssistantPorts } from '../AssistantStackStore';
import { readAssistantEnvFile } from '../assistantPaths';
import { readEnvFile } from '../stackEnv';

export interface HermesDashboardCredentials {
  username: string;
  password: string;
}

export interface HermesStackEndpoints {
  dashboardBaseUrl: string;
  apiBaseUrl: string;
  webuiBaseUrl: string;
}

function readProjectEnv(): Record<string, string> {
  const { root } = tryResolveAssistantRoot();
  return root ? readAssistantEnvFile(root) : {};
}

export function resolveHermesStackEndpoints(): HermesStackEndpoints {
  const ports = getStoredAssistantPorts();
  return {
    dashboardBaseUrl: `http://127.0.0.1:${ports.dashboard}`,
    apiBaseUrl: `http://127.0.0.1:${ports.apiServer}/v1`,
    webuiBaseUrl: `http://127.0.0.1:${ports.webui}`,
  };
}

export function resolveDashboardCredentials(): HermesDashboardCredentials | null {
  const env = readProjectEnv();
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
export function resolveDashboardHandoffSecret(): string | null {
  const secret = readProjectEnv().HERMES_DASHBOARD_HANDOFF_SECRET?.trim() ?? '';
  return secret.length >= 32 ? secret : null;
}

export function resolveApiServerKey(): string | null {
  for (const envPath of apiServerEnvCandidates()) {
    const key = readEnvFile(envPath).API_SERVER_KEY?.trim();
    if (key) return key;
  }
  const project = readProjectEnv();
  return project.API_SERVER_KEY?.trim() || null;
}

function apiServerEnvCandidates(): string[] {
  const paths: string[] = [];
  const { root } = tryResolveAssistantRoot();
  if (root) {
    paths.push(path.join(root, 'data', 'hermes', 'profiles', 'api-server', '.env'));
    paths.push(path.join(root, 'compose', 'hermes', 'api-server.env'));
  }
  try {
    paths.push(
      path.join(resolveActiveAssistantDataRoot(), 'hermes', 'profiles', 'api-server', '.env')
    );
  } catch {
    /* electron app path unavailable in some tests */
  }
  return paths;
}
