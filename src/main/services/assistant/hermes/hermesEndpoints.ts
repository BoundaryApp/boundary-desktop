import fs from 'node:fs';
import path from 'node:path';
import { resolveActiveAssistantDataRoot, tryResolveAssistantRoot } from '../resolveAssistantRoot';
import { getStoredAssistantPorts } from '../AssistantStackStore';

export interface HermesDashboardCredentials {
  username: string;
  password: string;
  secret?: string;
}

export interface HermesStackEndpoints {
  dashboardBaseUrl: string;
  apiBaseUrl: string;
  healthUrl: string;
  webuiBaseUrl: string;
}

function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readProjectEnv(): Record<string, string> {
  const { root } = tryResolveAssistantRoot();
  if (!root) return {};
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return {};
  try {
    return parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  } catch {
    return {};
  }
}

export function resolveHermesStackEndpoints(): HermesStackEndpoints {
  const ports = getStoredAssistantPorts();
  return {
    dashboardBaseUrl: `http://127.0.0.1:${ports.dashboard}`,
    apiBaseUrl: `http://127.0.0.1:${ports.apiServer}/v1`,
    healthUrl: `http://127.0.0.1:${ports.apiServer}/health`,
    webuiBaseUrl: `http://127.0.0.1:${ports.webui}`,
  };
}

export function resolveDashboardCredentials(): HermesDashboardCredentials | null {
  const env = readProjectEnv();
  const username =
    env.HERMES_DASHBOARD_USER ||
    env.HERMES_DASHBOARD_BASIC_AUTH_USERNAME ||
    'admin';
  const password =
    env.HERMES_DASHBOARD_PASSWORD ||
    env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD ||
    '';
  const secret =
    env.HERMES_DASHBOARD_AUTH_SECRET ||
    env.HERMES_DASHBOARD_BASIC_AUTH_SECRET ||
    undefined;
  if (!password) return null;
  return { username, password, secret };
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
    try {
      if (!fs.existsSync(envPath)) continue;
      const parsed = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
      const key = parsed.API_SERVER_KEY?.trim();
      if (key) return key;
    } catch {
      /* try next */
    }
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

export function resolveHermesModelId(): string | null {
  for (const envPath of apiServerEnvCandidates()) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const parsed = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
      const model = parsed.OPENAI_MODEL || parsed.MODEL || parsed.HERMES_MODEL;
      if (model?.trim()) return model.trim();
    } catch {
      /* try next */
    }
  }
  const project = readProjectEnv();
  return (
    project.OPENAI_MODEL?.trim() ||
    project.LLM_MODEL?.trim() ||
    project.MODEL?.trim() ||
    null
  );
}
